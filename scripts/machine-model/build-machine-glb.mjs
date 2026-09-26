#!/usr/bin/env node
// Builds the structured, web-ready tattoo machine GLB used by the homepage
// assembly sequence (specs/homepage-machine-assembly/).
//
// Input: the purchased single-mesh GLB (one node, one mesh, one material).
// Output: a GLB whose root node `Tattoo_mach` has one child node per semantic
// animation group (`G01_frame` ... `G18_rubber_bands`). Each group node sits at
// the group pivot; its child mesh node holds vertices relative to that pivot,
// so the runtime can translate/rotate groups without touching geometry.
//
// No Blender and no WebAssembly: parts are found by welding vertices by
// position and walking triangle connectivity, then matched to groups through
// the signature map in machine-groups.json. Geometry is compressed only with
// KHR_mesh_quantization, which Three.js r128 decodes without WebAssembly (the
// site CSP has no 'wasm-unsafe-eval').
//
// Usage:
//   node scripts/machine-model/build-machine-glb.mjs --source <model.glb> \
//     --out <out.glb> [--pivots <pivots.json>] [--texture-size 2048] [--check]
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize } from '@gltf-transform/functions';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_FILE = path.join(scriptDir, 'machine-groups.json');

// Output budget for --check. Geometry is measured before textures are added.
const EXPECTED_PARTS = 59;
const EXPECTED_GROUPS = 18;
const EXPECTED_TRIANGLES = 39988;
const MAX_GEOMETRY_BYTES = 800 * 1024;

function parseArgs(argv) {
  const args = { textureSize: 2048, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--check') args.check = true;
    else if (flag === '--source') args.source = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--pivots') args.pivots = argv[++i];
    else if (flag === '--texture-size') args.textureSize = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.source || !args.out) {
    throw new Error('Usage: build-machine-glb.mjs --source <model.glb> --out <out.glb> [--pivots <file>] [--texture-size N] [--check]');
  }
  if (![512, 1024, 2048, 4096].includes(args.textureSize)) {
    throw new Error(`--texture-size must be 512, 1024, 2048 or 4096 (got ${args.textureSize})`);
  }
  return args;
}

// ── Part detection ──────────────────────────────────────────────────────────

function findParts(positions, indices) {
  const vertexCount = positions.length / 3;
  // Weld by exact position: UV seams split vertices in glTF, which would
  // otherwise break one physical part into several index-connected pieces.
  const weldId = new Uint32Array(vertexCount);
  const byKey = new Map();
  for (let v = 0; v < vertexCount; v += 1) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    let id = byKey.get(key);
    if (id === undefined) {
      id = byKey.size;
      byKey.set(key, id);
    }
    weldId[v] = id;
  }

  const parent = new Uint32Array(byKey.size).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let t = 0; t < indices.length; t += 3) {
    union(weldId[indices[t]], weldId[indices[t + 1]]);
    union(weldId[indices[t]], weldId[indices[t + 2]]);
  }

  const parts = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const root = find(weldId[indices[t]]);
    if (!parts.has(root)) parts.set(root, { triangles: [], welded: new Set() });
    const part = parts.get(root);
    part.triangles.push(t / 3);
    for (let k = 0; k < 3; k += 1) part.welded.add(weldId[indices[t + k]]);
  }

  // Centroid over unique welded positions, matching the signature definition.
  const weldPosition = new Float64Array(byKey.size * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    weldPosition[weldId[v] * 3] = positions[v * 3];
    weldPosition[weldId[v] * 3 + 1] = positions[v * 3 + 1];
    weldPosition[weldId[v] * 3 + 2] = positions[v * 3 + 2];
  }
  return [...parts.values()].map((part) => {
    const centroid = [0, 0, 0];
    for (const w of part.welded) {
      centroid[0] += weldPosition[w * 3];
      centroid[1] += weldPosition[w * 3 + 1];
      centroid[2] += weldPosition[w * 3 + 2];
    }
    return {
      triangles: part.triangles,
      centroid: centroid.map((c) => c / part.welded.size),
    };
  });
}

function matchParts(found, map) {
  const byId = new Map();
  const failures = [];
  for (const spec of map.parts) {
    const candidates = found.filter((part) => part.triangles.length === spec.triangles
      && Math.hypot(...part.centroid.map((c, i) => c - spec.centroid[i])) <= map.matchTolerance);
    if (candidates.length !== 1) {
      failures.push(`${spec.id} (${spec.label}): ${candidates.length} candidates`);
      continue;
    }
    if ([...byId.values()].includes(candidates[0])) failures.push(`${spec.id}: matched a part already taken`);
    byId.set(spec.id, candidates[0]);
  }
  if (found.length !== map.parts.length) failures.push(`source has ${found.length} parts, map has ${map.parts.length}`);
  if (failures.length) throw new Error(`Part matching failed:\n  ${failures.join('\n  ')}`);
  return byId;
}

// ── Pivots and axes ─────────────────────────────────────────────────────────

function vertexSet(indices, triangles) {
  const set = new Set();
  for (const t of triangles) for (let k = 0; k < 3; k += 1) set.add(indices[t * 3 + k]);
  return set;
}

function bounds(positions, vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let a = 0; a < 3; a += 1) {
      const value = positions[v * 3 + a];
      if (value < min[a]) min[a] = value;
      if (value > max[a]) max[a] = value;
    }
  }
  return { min, max, center: min.map((m, a) => (m + max[a]) / 2) };
}

// Principal axis by power iteration on the 3×3 covariance matrix.
function principalAxis(positions, vertices) {
  const list = [...vertices];
  const mean = [0, 0, 0];
  for (const v of list) for (let a = 0; a < 3; a += 1) mean[a] += positions[v * 3 + a] / list.length;
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const v of list) {
    const d = [0, 1, 2].map((a) => positions[v * 3 + a] - mean[a]);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i][j] += d[i] * d[j];
  }
  let axis = [0.577, 0.577, 0.577];
  for (let iter = 0; iter < 64; iter += 1) {
    const next = [0, 1, 2].map((i) => cov[i][0] * axis[0] + cov[i][1] * axis[1] + cov[i][2] * axis[2]);
    const length = Math.hypot(...next);
    axis = next.map((c) => c / length);
  }
  // Deterministic sign: largest component positive.
  const largest = axis.reduce((best, c, i) => (Math.abs(c) > Math.abs(axis[best]) ? i : best), 0);
  if (axis[largest] < 0) axis = axis.map((c) => -c);
  return axis.map((c) => Math.round(c * 1e4) / 1e4);
}

function resolvePivot(group, positions, indices, partsById) {
  const groupVertices = vertexSet(indices, group.parts.flatMap((id) => partsById.get(id).triangles));
  const groupBounds = bounds(positions, groupVertices);
  const rule = group.pivot;
  const partBounds = rule.part ? bounds(positions, vertexSet(indices, partsById.get(rule.part).triangles)) : null;
  let pivot;
  switch (rule.type) {
    case 'bbox-center':
      pivot = groupBounds.center;
      break;
    case 'part-center':
      pivot = partBounds.center;
      break;
    case 'part-axis':
      // On the part's vertical axis; Y chosen by rule (group bottom = seat).
      pivot = [partBounds.center[0], rule.y === 'group-min' ? groupBounds.min[1] : partBounds.center[1], partBounds.center[2]];
      break;
    case 'hinge-min-x': {
      // Rear end of a blade: centre of the vertices within `depth` of min X.
      const edge = [...vertexSet(indices, partsById.get(rule.part).triangles)]
        .filter((v) => positions[v * 3] <= partBounds.min[0] + rule.depth);
      pivot = bounds(positions, edge).center;
      break;
    }
    default:
      throw new Error(`${group.id}: unknown pivot type ${rule.type}`);
  }
  let axis;
  if (group.axis.type === 'fixed') axis = group.axis.vector;
  else if (group.axis.type === 'pca') axis = principalAxis(positions, vertexSet(indices, partsById.get(group.axis.part).triangles));
  else throw new Error(`${group.id}: unknown axis type ${group.axis.type}`);
  return {
    pivot: pivot.map((c) => Math.round(c * 1e6) / 1e6),
    axis,
    bboxMin: groupBounds.min.map((c) => Math.round(c * 1e6) / 1e6),
    bboxMax: groupBounds.max.map((c) => Math.round(c * 1e6) / 1e6),
  };
}

// ── Textures ────────────────────────────────────────────────────────────────

// JPEG keeps the prototype free of WebAssembly decoders and extensions.
// Normal and metal/rough maps use 4:4:4 because chroma subsampling corrupts
// per-channel data (measured in Phase 1: 4:2:0 WebP gave 17° p99 normal error).
const TEXTURE_ENCODING = {
  baseColorTexture: { quality: 90, chromaSubsampling: '4:2:0' },
  normalTexture: { quality: 92, chromaSubsampling: '4:4:4' },
  metallicRoughnessTexture: { quality: 90, chromaSubsampling: '4:4:4' },
};

async function reencodeTextures(material, size) {
  const slots = {
    baseColorTexture: material.getBaseColorTexture(),
    normalTexture: material.getNormalTexture(),
    metallicRoughnessTexture: material.getMetallicRoughnessTexture(),
  };
  const report = {};
  for (const [slot, texture] of Object.entries(slots)) {
    if (!texture) throw new Error(`Source material has no ${slot}`);
    const encoding = TEXTURE_ENCODING[slot];
    const image = await sharp(Buffer.from(texture.getImage()))
      .resize(size, size, { kernel: 'lanczos3' })
      .removeAlpha()
      .jpeg({ quality: encoding.quality, chromaSubsampling: encoding.chromaSubsampling, mozjpeg: true })
      .toBuffer();
    texture.setImage(new Uint8Array(image)).setMimeType('image/jpeg').setURI('');
    report[slot] = { bytes: image.length, size };
  }
  return report;
}

// ── Build ───────────────────────────────────────────────────────────────────

async function build(args) {
  const map = JSON.parse(await fs.readFile(GROUPS_FILE, 'utf8'));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(args.source);
  const root = document.getRoot();

  const meshes = root.listMeshes();
  if (meshes.length !== 1 || meshes[0].listPrimitives().length !== 1) {
    throw new Error(`Expected one mesh with one primitive, found ${meshes.length} meshes`);
  }
  const sourcePrimitive = meshes[0].listPrimitives()[0];
  const material = sourcePrimitive.getMaterial();
  const attributes = {
    POSITION: sourcePrimitive.getAttribute('POSITION'),
    NORMAL: sourcePrimitive.getAttribute('NORMAL'),
    TEXCOORD_0: sourcePrimitive.getAttribute('TEXCOORD_0'),
  };
  for (const [name, accessor] of Object.entries(attributes)) {
    if (!accessor) throw new Error(`Source primitive has no ${name}`);
  }
  const positions = attributes.POSITION.getArray();
  const indices = sourcePrimitive.getIndices().getArray();
  if (indices.length / 3 !== EXPECTED_TRIANGLES) {
    throw new Error(`Expected ${EXPECTED_TRIANGLES} triangles, found ${indices.length / 3}`);
  }

  const partsById = matchParts(findParts(positions, indices), map);
  const assigned = map.groups.flatMap((group) => group.parts);
  if (new Set(assigned).size !== assigned.length || assigned.length !== map.parts.length) {
    throw new Error('Every part must belong to exactly one group');
  }

  const buffer = root.listBuffers()[0];
  const machineRoot = document.createNode('Tattoo_mach');
  const pivots = [];

  for (const group of map.groups) {
    const info = resolvePivot(group, positions, indices, partsById);
    const triangles = group.parts.flatMap((id) => partsById.get(id).triangles);
    const remap = new Map();
    const groupIndices = new Uint32Array(triangles.length * 3);
    triangles.forEach((t, i) => {
      for (let k = 0; k < 3; k += 1) {
        const source = indices[t * 3 + k];
        if (!remap.has(source)) remap.set(source, remap.size);
        groupIndices[i * 3 + k] = remap.get(source);
      }
    });

    const primitive = document.createPrimitive().setMaterial(material);
    for (const [name, accessor] of Object.entries(attributes)) {
      const itemSize = accessor.getElementSize();
      const sourceArray = accessor.getArray();
      const out = new Float32Array(remap.size * itemSize);
      for (const [source, target] of remap) {
        for (let c = 0; c < itemSize; c += 1) {
          out[target * itemSize + c] = sourceArray[source * itemSize + c] - (name === 'POSITION' ? info.pivot[c] : 0);
        }
      }
      primitive.setAttribute(name, document.createAccessor().setType(accessor.getType()).setArray(out).setBuffer(buffer));
    }
    const indexArray = remap.size <= 65535 ? Uint16Array.from(groupIndices) : groupIndices;
    primitive.setIndices(document.createAccessor().setType('SCALAR').setArray(indexArray).setBuffer(buffer));

    const nodeName = `${group.id}_${group.name}`;
    const mesh = document.createMesh(nodeName).addPrimitive(primitive);
    const meshNode = document.createNode(`${nodeName}_mesh`).setMesh(mesh);
    const groupNode = document.createNode(nodeName)
      .setTranslation(info.pivot)
      .setExtras({ group: group.name, axis: info.axis })
      .addChild(meshNode);
    machineRoot.addChild(groupNode);
    pivots.push({ id: group.id, name: group.name, node: nodeName, parts: group.parts.length, triangles: triangles.length, ...info });
  }

  // Replace the source scene graph with the grouped hierarchy.
  for (const scene of root.listScenes()) scene.dispose();
  for (const node of root.listNodes()) if (node.getMesh() === meshes[0]) node.dispose();
  meshes[0].dispose();
  const scene = document.createScene('machine').addChild(machineRoot);
  root.setDefaultScene(scene);
  material.setName('machine');

  await document.transform(
    prune(),
    dedup(),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 14, quantizationVolume: 'mesh' }),
  );

  // Geometry size before textures are re-encoded (for the budget check).
  const texturesBackup = root.listTextures().map((texture) => [texture, texture.getImage(), texture.getMimeType()]);
  for (const [texture] of texturesBackup) texture.setImage(new Uint8Array(0));
  const geometryBytes = (await io.writeBinary(document)).length;
  for (const [texture, image, mimeType] of texturesBackup) texture.setImage(image).setMimeType(mimeType);

  const textureReport = await reencodeTextures(material, args.textureSize);
  const glb = await io.writeBinary(document);

  const summary = {
    source: path.basename(args.source),
    groups: pivots.length,
    parts: assigned.length,
    triangles: pivots.reduce((sum, p) => sum + p.triangles, 0),
    geometryBytes,
    textures: textureReport,
    totalBytes: glb.length,
  };

  if (args.check) {
    const problems = [];
    if (summary.parts !== EXPECTED_PARTS) problems.push(`parts ${summary.parts} != ${EXPECTED_PARTS}`);
    if (summary.groups !== EXPECTED_GROUPS) problems.push(`groups ${summary.groups} != ${EXPECTED_GROUPS}`);
    if (summary.triangles !== EXPECTED_TRIANGLES) problems.push(`triangles ${summary.triangles} != ${EXPECTED_TRIANGLES}`);
    if (geometryBytes > MAX_GEOMETRY_BYTES) problems.push(`geometry ${geometryBytes} B > ${MAX_GEOMETRY_BYTES} B`);
    if (problems.length) throw new Error(`Check failed: ${problems.join('; ')}`);
  }

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, glb);
  if (args.pivots) {
    await fs.writeFile(args.pivots, `${JSON.stringify({ coordinateSystem: 'glTF Y-up metres, model space', groups: pivots }, null, 2)}\n`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

build(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
