# Implementation Plan: Homepage tattoo machine assembly sequence

## Specification

- Spec: `specs/homepage-machine-assembly/spec.md`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Target branch/PR: `claude/tattoo-machine-3d-analysis-l5voti`, no PR in Phase 2
- Exact target SHA: branch created from `origin/main` at `4dd40fe`

## Constitution check

- IV Exact-head evidence: all "current behaviour" claims below were measured at
  `4dd40fe`; production `index.html` 3D block matched the repository except for the
  Cloudflare email-decode injection (checked 2026-09-26).
- VII Deployment is separate evidence: Phase 2 ships no production change.
- VIII Bounded change: Phase 2 touches only `specs/`, `scripts/machine-model/`,
  `prototypes/machine-assembly/`, one validator rule, `.gitignore`, and dev
  dependencies. `index.html`, `_headers`, `components.js` and `assets/vendor/` stay
  untouched.
- Principles I–III, V, VI (server authority, RLS, migrations, provider delivery,
  credentials) are not affected: static marketing page, no data, no secrets.

## Current-state evidence (at `4dd40fe`)

- Entry point: `index.html:289-663` (`#machine-section` + inline script), canvas
  mounted into fixed `#machine-bg` (`index.html:149`).
- Libraries: `assets/vendor/three/0.128.0/three.min.js` (603 KB, 149 KB gzip),
  `assets/vendor/gsap/3.12.5/*` (gsap 28 KB + ScrollTrigger 18 KB gzip), pinned by
  `scripts/vendor-3d-libs.mjs`.
- Measured behaviour (headless Chromium, SwiftShader): the canvas keeps rendering
  while Portfolio is on screen (2 805 draw calls in 2 s desktop, 5 478 mobile);
  `#machine-canvas-wrap` does not stick (`top = -371px` mid-section) because the
  section has `overflow:hidden`.
- `components.js:765` adds `.reveal` (opacity/transform/`filter: blur`) to every
  `main section`, and `components.js:776` adds a transform parallax to `main > header`
  (creates a stacking context on the hero). Both matter for Phase 3 integration.
- CSP (`_headers`): `script-src 'self' 'unsafe-inline' …` without
  `'wasm-unsafe-eval'`. Verified: Meshopt decoding fails with "Refused to compile or
  instantiate WebAssembly module"; it succeeds only when the keyword is added.
- Cloudflare Pages publishes the repository root (`/AGENTS.md`, `/docs/…`,
  `/package.json` return 200 on production).
- `scripts/validate-site.mjs` treats every `.html` except `404.html` as an
  indexable page that must be in the sitemap.

## Source model facts (Phase 1)

- Formats checked: original FBX 7400, "optimized" FBX, OBJ/MTL, DAE, 2K analysis GLB.
  Geometry is identical in all of them (max position difference 5e-7 m; GLB vs FBX 0).
- 1 node / 1 mesh / 1 material `Black_wood`, 23 696 glTF vertices, 39 988 triangles,
  real scale 13.8 × 5.6 × 22.9 cm (Blender Z-up; glTF Y-up).
- 59 disconnected parts (the often-quoted 116 is the count of index-connected pieces
  after UV-seam vertex splitting).
- GLB material: base colour, packed metal/rough (R unused, G roughness, B metal),
  normal map in OpenGL convention (integrability test), `doubleSided: true`,
  no tangents, two empty extra scenes.
- Texel density: 14.5 texels/mm at 4K, 7.3 at 2K, 3.6 at 1K.

## Semantic groups and pivots

Coordinates below are glTF Y-up metres in model space (X toward the needle,
Y up, Z toward the side that carries the frame upright). The pivot is the group
node origin; mesh vertices are stored relative to it.

| Group | Source parts | Pivot rule | Motion | Rotation |
| --- | --- | --- | --- | --- |
| G01 frame | 50 | bbox centre | small settle | yaw ≤ 10° |
| G02 coil_rear | 11,12,36,10,30,58,37 | winding axis, group bottom | straight down onto yoke (frame side plate blocks +Z) | about Y ≤ 40° |
| G03 coil_front | 0,19,31,20,35,57,38 | winding axis, group bottom | straight down onto yoke | about Y ≤ 35° |
| G04 capacitor | 32 | bbox centre | down from above (trapped between coils and upright) | none |
| G05 wiring | 2,3,4,5,6,26,34 | bbox centre | fade + 2–3 mm settle | none |
| G06 armature_bar | 48,54 | bbox centre | from behind (−Z) above the coils, then down | tilt about Z ≤ 5° |
| G07 spring | 27 | rear hinge (min X end) | after the armature seats; swing down | about Z ≈ 11° |
| G08 armature_clamp_hw | 42,18,24,17 | cap-screw axis | down its axis | screw turns about Y |
| G09 rear_saddle_hw | 41,14,23,13,7 | cap-screw axis | down its axis | screw turns about Y |
| G10 contact_barrel | 46,22,43,44,15,16,33 | barrel centroid | along its axis (Z) | none |
| G11 contact_screw | 51 | screw centroid (on axis) | along its 45° axis | screw turns about axis |
| G12 binding_post | 47,1,9,25,29,40 | post axis | down + rearward | about Y |
| G13 vise_screw | 56,28,8,39 | screw axis | along its axis (Z) | wing turns about Z |
| G14 tube_stem | 49 | column axis | up into vise | none |
| G15 grip | 52 | column axis | up along the column, around the needle | about Y ≤ 70° |
| G16 tip | 21 | column axis | up along column | none |
| G17 needle | 53 | column axis | down through the tube stem (stage B, before the armature) | none |
| G18 rubber_bands | 45,55 | bbox centre | scale 1.04→1 + fade | none |

Parts are identified by a signature (triangle count + rounded centroid), not by
index, so the map survives re-export from the 4K original.

## Proposed design

### Asset pipeline (no Blender)

`scripts/machine-model/build-machine-glb.mjs` (Node, `@gltf-transform/core` +
`functions`, `sharp`):

1. Read the source GLB (path argument; default analysis copy outside the repo).
2. Weld by position, find the 59 connected parts, match signatures from
   `scripts/machine-model/machine-groups.json`, fail loudly on any unmatched or
   duplicate part.
3. Per group: create `G##_<name>` node at the pivot (animated), a child mesh node,
   and a primitive with vertices relative to the pivot.
4. Drop the empty scenes; keep one material; re-encode textures (base colour JPEG,
   normal and metal/rough JPEG 4:4:4) at the requested size.
5. `quantize` (KHR_mesh_quantization; position 14 bit, normal 10 bit,
   texcoord 14 bit), `dedup`, `prune`.
6. Write the GLB plus `machine-pivots.json` (pivot, axis, bbox per group).

### Prototype (`prototypes/machine-assembly/`)

- `index.html`: static copy of the homepage hero (Featured-in moved inside the hero
  near its bottom), the sequence section, and a Portfolio stub using existing
  thumbnails; `noindex`; site CSS and fonts.
- `machine-assembly.js`: classic script on the global `THREE` (r128).
  - Layout: section = overlap into hero + sticky 100 vh stage + scroll distance
    (desktop 140 vh, mobile 110 vh); canvas stage is `position: sticky`.
  - Progress: own passive scroll handler, damped in `requestAnimationFrame`; frames
    are rendered only while the damped value moves or on resize.
  - Timeline: `timeline.js` data (per-group window, exploded offset for landscape and
    portrait, rotation, screw turns, easing) evaluated as a pure function of progress.
  - Camera: keyframes (position, target, FOV, roll) per layout, smooth interpolation.
  - Lighting: RoomEnvironment PMREM for reflections, warm key and cool rim
    directional lights; key azimuth sweeps during the hero moment; exposure falls to
    black during the upright wipe.
  - Lifecycle: IntersectionObserver gates rendering; `visibilitychange` pauses;
    `webglcontextlost` → poster; init on first scroll or idle after `load`.
  - Fallbacks: poster image for no-WebGL, weak device, save-data, load error; reduced
    motion shows one static assembled frame without extra scroll length.
  - Debug (`?debug=1`): progress slider, stage name, pivot/axis helpers, stats.
- `lib/GLTFLoader.js`, `lib/RoomEnvironment.js`: byte-identical copies from
  `three@0.128.0/examples/js/` (hashes recorded in `README.md`).

### Analysis tooling

`scripts/machine-model/check-assembly-paths.mjs` evaluates `timeline.js` with the
runtime's pose maths, samples every group's surface (4 points/mm²) and reports, for
each moving group, the minimum distance to every other group and the number of
samples behind the other group's surface, excluding the final 8% seating move.

### Camera fit

Camera keys marked `fit` are re-solved at runtime (and on resize) so every group,
in its pose at that progress, fits the viewport safe area below the fixed nav. This
replaces per-aspect hand tuning.

## Security review

- Browser-controlled values: only `?debug`/`?p` query flags in the prototype, used
  for display; no data sinks.
- CSP unchanged; no inline event handlers; no third-party origins.
- Secrets: none. Purchased raw sources stay outside published paths (SR-003).

## Test strategy

- `npm run validate:site` with a new rule: pages under `prototypes/` must carry
  `noindex`, must not be in the sitemap, and are exempt from indexable-page checks.
- `node scripts/machine-model/build-machine-glb.mjs --check` verifies part coverage
  (59/59), group count (18), triangle count (39 988) and output budget.
- Headless Chromium screenshots at storyboard stages (desktop 1440×900, mobile
  390×844 at DPR 3) and a draw-call counter out of view.
- Real-device GPU timing (iPhone Safari, mid-range Android) is required in Phase 3;
  SwiftShader timings are not representative.

## Rollout plan

1. Phase 2 (this plan): branch-only prototype, no PR.
2. Phase 3 (after visual approval): integrate into `index.html`, remove the
   procedural scene and GSAP dependency from the homepage, update
   `scripts/vendor-3d-libs.mjs`, move Featured-in, build the 4K-sourced production
   GLB and posters; PR with Static Validation.
3. Phase 4: real-device QA, production deploy only with owner approval, then
   production verification.

## Rollback/reference plan

Phase 2 is additive and unreferenced by production pages. Phase 3 keeps the old
section in git history; reverting the integration commit restores it.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Raw sources committed to a published path | purchased model downloadable; licence 21A.3 | keep raw sources out of git until a storage decision |
| Branch preview deployments publish the prototype | public preview URL | `noindex`; Pages previews add `X-Robots-Tag: noindex`; verify in dashboard |
| Uncompressed textures | ≈ 50 MB GPU on desktop | 1K fallbacks on mobile; measure on devices |
| Cloudflare may not compress `.glb` | geometry 712 KB instead of ≈ 300–410 KB | verify on production URL in Phase 3 |
| Hero parallax transform in `components.js` | overlap z-order differs from prototype | handle in Phase 3 (z-index on hero content) |
| Thin geometry aliasing (needle, wires) | shimmering on mobile | MSAA, DPR ≥ 1.5, camera avoids needle macro |

## Phase 3 plan: integration (approved Phase 2 on 2026-09-26)

### Dependency: public deploy boundary (separate change, lands first)

Cloudflare Pages uses Git integration with no build command, so the output
directory is the repository root (`docs/static-html-build.md:42-46`). Pages only
auto-excludes `.git`, `node_modules` and `.DS_Store`; it has no ignore file.
Verified on production (2026-09-26, GET only): `/AGENTS.md`, `/package.json`,
`/.mcp.json`, `/.env.example`, `/.github/workflows/*.yml`, `/workers/*.js`,
`/scripts/*.mjs`, `/docs/audits/*.md`, `/geo_agent/*`, `/tests/*.py` return 200;
`/.git/*`, `/_headers`, `/_redirects` return 404. A secret-pattern scan of tracked
files found no credentials; the exposure is internal information.

Proposed fix (separate branch/PR, owner applies the dashboard change):
`scripts/build-public.mjs` copies an explicit allowlist (sitemap pages, `404.html`,
root public files, `assets/**` media/css/js/fonts/licences, `_headers`,
`_redirects`) into `dist/`; Pages build command `node scripts/build-public.mjs`,
output directory `dist`, `SKIP_DEPENDENCY_INSTALL=1`. Dry run on `4dd40fe`:
15 pages, 928 files, 92.4 MB, 2 273 local references resolved, 0 internal files.
`prototypes/` is excluded from production output.

Phase 3 must not merge before this boundary is live, because it adds new public
assets and relies on `prototypes/` staying unpublished.

### Integration steps

1. Model: build desktop and mobile GLBs from the 4K original (owner supplies it in
   `source-assets/`), split the contact-barrel outer hardware and under-frame screws
   (19–20 groups), rerun the path sweep, target GLB ≤ 1.6 MB desktop / ≤ 1.0 MB
   mobile. Output under `assets/3d/machine/` with content-hashed file names.
2. Runtime: promote `prototypes/machine-assembly/machine-assembly.js` and
   `timeline.js` to `assets/js/` (debug/capture hooks kept behind `?debug` only in
   non-production builds or removed); vendor `GLTFLoader.js` and
   `RoomEnvironment.js` into `assets/vendor/three/0.128.0/examples/` through
   `scripts/vendor-3d-libs.mjs` with pinned hashes.
3. `index.html`: remove the fixed `#machine-bg` layer (`:149`), the Recognition strip
   section (`:285-287`) and the old `#machine-section` + inline script (`:289-663`);
   move "Featured in" into the hero content; add the new section; section CSS goes
   into `assets/css/input.css` (compiled by `build:tailwind`) so layout is known at
   first paint (no CLS).
4. Remove GSAP/ScrollTrigger from the homepage (only `index.html` uses them); update
   `validate-site.mjs` vendor and homepage-reference checks accordingly.
5. `components.js`: exclude the sequence section from `.reveal` (blur/transform) and
   stop the hero parallax transform on the homepage (it creates a stacking context
   that would put hero text under the canvas in the overlap band).
6. Posters: `scripts/machine-model/render-posters.mjs` renders the four posters from
   the production GLB.
7. `_headers`: long-lived immutable caching for `/assets/3d/*` (hashed names). CSP
   unchanged.
8. Validation: `validate:site`, `build:html:check`, path sweep, storyboard
   screenshots, Lighthouse mobile/desktop against the preview URL, real-device QA
   (iPhone Safari, Android Chrome, desktop Safari/Chrome/Firefox).
9. Rollout: PR with Static Validation → preview QA → owner approval → merge →
   production verification (GLB status/type/cache/compression, no GSAP requests,
   0 3D requests before scroll, LCP unchanged). Rollback: revert the merge commit.
