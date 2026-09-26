#!/usr/bin/env node
// Assembly path clearance check for the homepage machine sequence
// (specs/homepage-machine-assembly/, AC-002).
//
// Evaluates prototypes/machine-assembly/timeline.js with the same pose maths
// as the runtime, samples every group's surface as points (with face
// normals), and at each progress step measures, for every group that is
// moving, the minimum distance to every other group. Contacts are reported:
//   - during approach (mover not yet in the last `seatShare` of its window):
//     potential collision or visible pass-through;
//   - at rest (p = 1): designed seat contacts, used as the baseline.
// A "penetration" count is the number of mover sample points that lie behind
// the nearest surface point of the other group (dot(p − q, n_q) < 0) within
// `penetrationRadius`; it separates a graze from an overlap.
//
// Usage:
//   node scripts/machine-model/check-assembly-paths.mjs [--glb <file>] \
//     [--timeline <file>] [--layout landscape|portrait|both] [--steps 160] [--json <out>]
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULTS = {
  glb: path.join(rootDir, 'prototypes/machine-assembly/assets/tattoo-machine.glb'),
  timeline: path.join(rootDir, 'prototypes/machine-assembly/timeline.js'),
  layout: 'both',
  steps: 160,
};
const SAMPLES_PER_MM2 = 4; // ≈0.5 mm spacing
const CONTACT_MM = 0.35; // closer than this counts as contact at this sampling density
const PENETRATION_RADIUS_MM = 0.6;
const SEAT_SHARE = 0.08; // last 8% of a window is the seating move

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--glb') args.glb = argv[++i];
    else if (flag === '--timeline') args.timeline = argv[++i];
    else if (flag === '--layout') args.layout = argv[++i];
    else if (flag === '--steps') args.steps = Number(argv[++i]);
    else if (flag === '--json') args.json = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

// ── Pose maths (mirrors prototypes/machine-assembly/machine-assembly.js) ────
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const easeInOutCubic = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };

function pathOffset(offset, via, k) {
  if (!via) return offset.map((c) => c * k);
  const first = Math.hypot(offset[0] - via[0], offset[1] - via[1], offset[2] - via[2]);
  const second = Math.hypot(...via);
  const along = k * (first + second);
  if (along <= second) {
    const f = second > 0 ? along / second : 0;
    return via.map((c) => c * f);
  }
  const g = (along - second) / first;
  return via.map((c, i) => lerp(c, offset[i], g));
}

function quatFromAxisAngle(axis, angle) {
  const len = Math.hypot(...axis) || 1;
  const s = Math.sin(angle / 2) / len;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}
function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

function groupPose(group, spec, layout, p) {
  const t = clamp((p - spec.window[0]) / (spec.window[1] - spec.window[0]), 0, 1);
  const k = 1 - easeInOutCubic(t);
  let offset = [0, 0, 0];
  if (spec.along === 'axis') offset = group.axis.map((c) => c * spec.offset[layout] * k);
  else if (spec.offset) offset = pathOffset(spec.offset[layout], spec.via && spec.via[layout], k);
  let q = [0, 0, 0, 1];
  if (spec.rot) q = quatFromAxisAngle(spec.rot.axis === 'axis' ? group.axis : spec.rot.axis, spec.rot.angle * k);
  if (spec.turns) {
    const share = spec.threadShare || 0.5;
    const thread = clamp((t - (1 - share)) / share, 0, 1);
    q = quatMultiply(q, quatFromAxisAngle(group.axis, spec.turns * Math.PI * 2 * (1 - smooth(thread))));
  }
  const scale = spec.scale ? lerp(1, spec.scale, k) : 1;
  const visible = !spec.fade || k < 0.998;
  return { t, q, scale, visible, translation: group.pivot.map((c, i) => c + offset[i]) };
}

// ── Geometry sampling ───────────────────────────────────────────────────────
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function transformPoint(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

async function loadGroups(glbPath) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(glbPath);
  await document.transform(dequantize());
  const root = document.getRoot().listScenes()[0].listChildren()[0];
  const random = mulberry32(7);
  return root.listChildren().map((groupNode) => {
    const meshNode = groupNode.listChildren()[0];
    const matrix = meshNode.getMatrix(); // mesh node local transform (quantization volume)
    const primitive = meshNode.getMesh().listPrimitives()[0];
    const position = primitive.getAttribute('POSITION');
    const indices = primitive.getIndices().getArray();
    const points = [];
    const normals = [];
    const v = [0, 0, 0];
    const corner = (index) => transformPoint(matrix, position.getElement(index, v));
    for (let t = 0; t < indices.length; t += 3) {
      const a = corner(indices[t]); const b = corner(indices[t + 1]); const c = corner(indices[t + 2]);
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const doubleArea = Math.hypot(...n);
      if (doubleArea === 0) continue;
      const areaMm2 = (doubleArea / 2) * 1e6;
      const exact = areaMm2 * SAMPLES_PER_MM2;
      const count = Math.floor(exact) + (random() < exact - Math.floor(exact) ? 1 : 0);
      const unit = n.map((c) => c / doubleArea);
      for (let s = 0; s < count; s += 1) {
        let r1 = random(); let r2 = random();
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        points.push([a[0] + ab[0] * r1 + ac[0] * r2, a[1] + ab[1] * r1 + ac[1] * r2, a[2] + ab[2] * r1 + ac[2] * r2]);
        normals.push(unit);
      }
    }
    const extras = groupNode.getExtras();
    return {
      name: groupNode.getName(),
      pivot: groupNode.getTranslation(),
      axis: extras.axis || [0, 1, 0],
      points,
      normals,
    };
  });
}

// ── Spatial hash ────────────────────────────────────────────────────────────
const CELL = 0.001; // 1 mm
const cellKey = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;

function posedPoints(group, pose) {
  const world = new Array(group.points.length);
  const normals = new Array(group.points.length);
  for (let i = 0; i < group.points.length; i += 1) {
    const r = rotate(pose.q, group.points[i]);
    world[i] = [r[0] * pose.scale + pose.translation[0], r[1] * pose.scale + pose.translation[1], r[2] * pose.scale + pose.translation[2]];
    normals[i] = rotate(pose.q, group.normals[i]);
  }
  return { world, normals };
}

function buildHash(entries) {
  const hash = new Map();
  entries.forEach((entry, g) => {
    if (!entry) return;
    entry.world.forEach((pt, i) => {
      const key = cellKey(pt[0], pt[1], pt[2]);
      let bucket = hash.get(key);
      if (!bucket) { bucket = []; hash.set(key, bucket); }
      bucket.push(g, i);
    });
  });
  return hash;
}

// For each other group: nearest distance from any mover point, and how many
// mover points sit behind the nearest surface sample of that group.
function measureMover(moverIndex, entries, hash) {
  const mover = entries[moverIndex];
  const result = new Map();
  for (const pt of mover.world) {
    const cx = Math.floor(pt[0] / CELL); const cy = Math.floor(pt[1] / CELL); const cz = Math.floor(pt[2] / CELL);
    const nearest = new Map(); // group → [dist, index]
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const bucket = hash.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!bucket) continue;
      for (let b = 0; b < bucket.length; b += 2) {
        const g = bucket[b];
        if (g === moverIndex) continue;
        const q = entries[g].world[bucket[b + 1]];
        const d = Math.hypot(pt[0] - q[0], pt[1] - q[1], pt[2] - q[2]);
        const prev = nearest.get(g);
        if (!prev || d < prev[0]) nearest.set(g, [d, bucket[b + 1]]);
      }
    }
    for (const [g, [d, i]] of nearest) {
      let entry = result.get(g);
      if (!entry) { entry = { min: Infinity, behind: 0 }; result.set(g, entry); }
      if (d < entry.min) entry.min = d;
      if (d * 1000 < PENETRATION_RADIUS_MM) {
        const q = entries[g].world[i]; const n = entries[g].normals[i];
        if ((pt[0] - q[0]) * n[0] + (pt[1] - q[1]) * n[1] + (pt[2] - q[2]) * n[2] < -0.00005) entry.behind += 1;
      }
    }
  }
  return result;
}

function checkLayout(groups, timeline, layout, steps) {
  const approach = new Map(); // "mover|other" → worst record
  const rest = new Map();
  for (let step = 0; step <= steps; step += 1) {
    const p = step / steps;
    const poses = groups.map((g) => groupPose(g, timeline.groups[g.name], layout, p));
    const entries = groups.map((g, i) => (poses[i].visible ? posedPoints(g, poses[i]) : null));
    const hash = buildHash(entries);
    groups.forEach((g, i) => {
      const pose = poses[i];
      const moving = pose.t > 0 && pose.t < 1 - SEAT_SHARE;
      const atRest = step === steps;
      if (!entries[i] || (!moving && !atRest)) return;
      for (const [other, m] of measureMover(i, entries, hash)) {
        const key = `${g.name}|${groups[other].name}`;
        const record = { p: +p.toFixed(4), t: +pose.t.toFixed(3), minMm: +(m.min * 1000).toFixed(2), behind: m.behind };
        const target = atRest ? rest : approach;
        const prev = target.get(key);
        if (!prev || record.minMm < prev.minMm || (record.minMm === prev.minMm && record.behind > prev.behind)) target.set(key, record);
      }
    });
  }
  const contacts = [...approach.entries()]
    .filter(([, r]) => r.minMm < CONTACT_MM)
    .map(([key, r]) => {
      const [mover, other] = key.split('|');
      const restRecord = rest.get(key) || rest.get(`${other}|${mover}`);
      return { mover, other, ...r, restMinMm: restRecord ? restRecord.minMm : null };
    })
    .sort((a, b) => b.behind - a.behind || a.minMm - b.minMm);
  const clearance = groups.map((g) => {
    const rows = [...approach.entries()].filter(([key]) => key.startsWith(`${g.name}|`));
    const worst = rows.sort((a, b) => a[1].minMm - b[1].minMm)[0];
    return { group: g.name, approachMinMm: worst ? worst[1].minMm : null, nearest: worst ? worst[0].split('|')[1] : null, atP: worst ? worst[1].p : null };
  });
  return { layout, steps, contacts, clearance };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = await fs.readFile(args.timeline, 'utf8');
  const sandbox = { module: undefined };
  vm.runInNewContext(`${source}\nthis.MACHINE_TIMELINE = MACHINE_TIMELINE;`, sandbox);
  const timeline = sandbox.MACHINE_TIMELINE;
  const groups = await loadGroups(args.glb);
  const layouts = args.layout === 'both' ? ['landscape', 'portrait'] : [args.layout];
  const report = {
    samplesPerMm2: SAMPLES_PER_MM2,
    contactThresholdMm: CONTACT_MM,
    seatShare: SEAT_SHARE,
    samplePoints: groups.reduce((sum, g) => sum + g.points.length, 0),
    layouts: layouts.map((layout) => checkLayout(groups, timeline, layout, args.steps)),
  };
  if (args.json) await fs.writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
  for (const result of report.layouts) {
    console.log(`\n[${result.layout}] approach contacts < ${CONTACT_MM} mm (mover not yet seating):`);
    if (!result.contacts.length) console.log('  none');
    for (const c of result.contacts) {
      console.log(`  ${c.mover} ↔ ${c.other}: ${c.minMm} mm at p=${c.p} (t=${c.t}), behind-surface points ${c.behind}, rest contact ${c.restMinMm} mm`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
