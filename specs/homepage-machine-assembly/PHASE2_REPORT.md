# Phase 2 report: isolated prototype

- Feature: `specs/homepage-machine-assembly/`
- Branch: `claude/tattoo-machine-3d-analysis-l5voti`, base `4dd40fe` (`origin/main`)
- Prototype: `prototypes/machine-assembly/` (`noindex`, unlinked)
- Production files (`index.html`, `_headers`, `components.js`, `assets/vendor/*`): unchanged
- Measurements: headless Chromium 141.0.7390.37 with SwiftShader (software GPU) on the local
  static server. Timings from SwiftShader are not device timings; draw calls,
  triangle counts, request lists and frame counts are exact.

## Evidence

| File | Content |
| --- | --- |
| `evidence/storyboard-desktop.jpg` | real-scroll frames at 1440×900: hero → entry → A–I → handoff → Portfolio |
| `evidence/storyboard-mobile.jpg` | the same at 390×844 @2x |
| `evidence/pivots-debug.jpg` | `?debug=1`: pivot axes (RGB) and motion axes (yellow) of the 18 groups |
| `evidence/assembly-paths.json` | clearance sweep, 120 steps per layout, 236 338 surface samples |
| `evidence/runtime-metrics.json` | requests, frames, draw calls, triangles per layout |

## What the prototype does

1. Hero stays static HTML; "Featured in" is the last line of the hero content.
2. The sequence section starts 22 vh (desktop) / 14 vh (mobile) inside the hero's
   bottom gradient. A black shade over the top of the stage fades out as the visitor
   scrolls, so the exploded parts rise out of the gradient.
3. Sticky stage, scroll distance 140 vh desktop / 110 vh mobile (measured).
4. Assembly A–F, hero moment G (orbit ≈ 7°, key-light sweep), push-in H toward the
   armature/coil junction, the frame upright crosses the lens, exposure falls to 0,
   the stage leaves on pure black and the Portfolio heading follows with nothing in
   between.
5. "Skip to portfolio" inside the stage; the hero "View Work" link jumps directly.

## Pivots

Pivots are computed by `build-machine-glb.mjs` from rules in
`scripts/machine-model/machine-groups.json` and written into node extras and
`assets/machine-pivots.json` (glTF Y-up metres):

| Group | Pivot rule | Pivot | Motion / rotation axis |
| --- | --- | --- | --- |
| G01 frame | bbox centre | (0.0006, 0.0502, 0.0019) | Y |
| G02 coil_rear | winding axis, group bottom | (−0.0152, 0.0191, −0.0026) | Y |
| G03 coil_front | winding axis, group bottom | (0.0180, 0.0146, −0.0026) | Y |
| G04 capacitor | bbox centre | (0.0051, 0.0488, 0.0104) | Y |
| G05 wiring | bbox centre | (−0.0122, 0.0550, 0.0080) | fade only |
| G06 armature_bar | bbox centre | (0.0161, 0.0725, −0.0026) | Y; tilt about Z |
| G07 spring | rear hinge (min X) | (−0.0620, 0.0715, −0.0026) | swing about Z |
| G08 armature_clamp_hw | cap-screw centre | (−0.0141, 0.0781, −0.0026) | Y (screw) |
| G09 rear_saddle_hw | cap-screw centre | (−0.0554, 0.0773, −0.0026) | Y (screw) |
| G10 contact_barrel | barrel centre | (0.0210, 0.0904, 0.0004) | PCA (0, −0.001, 1) |
| G11 contact_screw | screw centre | (0.0176, 0.0941, −0.0026) | PCA (−0.707, 0.707, 0) |
| G12 binding_post | post axis, group bottom | (−0.0547, 0.0105, −0.0026) | Y |
| G13 vise_screw | shaft centre | (0.0419, 0.0192, −0.0078) | PCA (0, 0, 1) |
| G14 tube_stem | bbox centre | (0.0537, 0.0126, −0.0026) | Y |
| G15 grip | bbox centre | (0.0537, −0.0477, −0.0026) | Y |
| G16 tip | bbox centre | (0.0537, −0.0980, −0.0026) | Y |
| G17 needle | bbox centre | (0.0537, −0.0233, −0.0026) | Y |
| G18 rubber_bands | bbox centre | (0.0083, 0.0504, 0.0006) | fade + scale |

The column parts (G14–G17) share one axis (x 0.0537, z −0.0026) to within 5 µm,
so grip, tip and needle slide coaxially. Screw rotations happen about the PCA axis
through the part centre, which lies on the thread axis for these symmetric parts.

## Intersections

The sweep samples 4 points/mm² (≈0.5 mm spacing), moves every group along its
timeline path and reports contacts closer than 0.35 mm while the mover is not yet in
the last 8% of its window. Full data: `evidence/assembly-paths.json`.

### Fixed during Phase 2 (found by the sweep)

| Problem | Cause | Fix |
| --- | --- | --- |
| Front coil and capacitor passed through the frame | the frame's side plate occupies the camera side (+Z) from y 21 mm to 99 mm; above both coil seats only the yoke (y ≤ 28.5 mm) remains | coils and capacitor now arrive from above |
| Armature went through the hovering needle | the needle is 20 cm long; any hover above its seat crosses the armature seat | needle drops through the tube before the coils; grip and tip slide up around it coaxially |
| Coils went through the hovering armature | armature hovered above the coil columns | armature hovers 6 cm behind (−Z), then drops |
| Spring crossed the hovering saddle/clamp screws | exploded positions overlapped | spring moves after the armature seats; screws hover 11–13 cm up |
| Tube stem started inside the vise | frame yaw during its settle | stem starts 5–6 cm lower, after the frame settles |

Remaining mid-air collisions between exploded parts: none.

### Remaining contacts (accepted or Phase 3 work)

| Contact | When | Nature | Decision |
| --- | --- | --- | --- |
| Wiring, rubber bands ↔ coils, frame, needle | while fading in (opacity < 0.6) | fade groups with a 4–6 mm settle | accept; optionally reduce settle to 2 mm |
| Screws ↔ frame/spring/barrel (G08, G09, G11, G13) | last 12–22% of travel | threads entering holes that are not modelled as cavities | accept |
| Grip ↔ stem, tip ↔ grip | last ~12–18% | sleeve insertion | accept |
| Armature nipple ↔ needle loop | last 18–25% | loop hooks over the nipple; ≈2–3 mm of wire overlap | accept (hidden by the nipple) |
| Contact barrel ↔ frame | 22–32% before seat | barrel washers/nuts pass through the upright's hole | Phase 3: split outer nut and washers into their own group (19th) |
| Coil screws (p37, p38) ↔ yoke; binding-post cap (p40) ↔ lug | last ~30% | screws sit under the yoke/lug but belong to groups that come from above | Phase 3: move to an "under-frame screws" group that rises from below, or accept (below the camera line) |
| Capacitor ↔ front coil washer | mid-drop, 0.07–0.17 mm | graze | Phase 3: shift the drop 1 mm toward −X |

## Performance

| Metric | Desktop 1440×900 | Mobile 390×844 @2x |
| --- | --- | --- |
| 3D requests during initial page load | 0 | 0 |
| Scroll distance owned by the sequence | 140 vh (1 260 px) | 110 vh (928 px) |
| Draw calls per frame | 16 during assembly, 18 assembled (p 0.78), 15 in the close-up (frustum culling) | same |
| Triangles per frame | 36 108 during assembly, 39 988 assembled | same |
| Programs / textures / geometries | 5 / 4 / 20 | same |
| Drawing buffer | 1440×900 (DPR 1) | 780×1688 (DPR 2) |
| Frames while Portfolio is on screen (10 wheel steps) | 0 | 0 |
| Frames while idle inside the sequence (2 s after settling) | 0 | 0 |
| JS heap after load | 6 MB | 6 MB |

Lazy payload, fetched on first scroll or idle after `load`:

| File | Raw | gzip | brotli |
| --- | --- | --- | --- |
| `three.min.js` r128 (already vendored) | 603 KB | 149 KB | — |
| `GLTFLoader.js` r128 | 96.6 KB | 21.9 KB | 18.3 KB |
| `RoomEnvironment.js` r128 | 3.4 KB | 1.0 KB | 0.8 KB |
| `machine-assembly.js` + `timeline.js` + CSS | 38 KB | 12 KB | 10 KB |
| `tattoo-machine.glb` (geometry 732 KB + 2K JPEG textures 2.42 MB) | 3.16 MB | 2.74 MB | 2.62 MB |
| poster (one per layout/state) | 15–40 KB | — | — |

GPU memory (estimate, not measured): three 2K textures decoded to RGBA8 with mipmaps
≈ 22 MB each, ≈ 67 MB total, plus a small PMREM environment. This is the largest
open risk for older iPhones and is the reason texture work is scheduled for Phase 3.

Not measured here (requires real devices): frame time on iPhone Safari and mid-range
Android, WebGL memory pressure, thermal behaviour, Cloudflare compression of `.glb`
(requires production URL).

## Deviations from the Phase 1 storyboard

- Order: the needle now drops in stage B (after the tube stem, before the coils), and
  grip/tip slide up around it in stage E. The Phase 1 order (needle last) makes the
  20 cm needle cross the armature seat, which the sweep proved unavoidable.
- The capacitor lands from above instead of from the side (trapped between the coils
  and the upright).

## Recommendations for Phase 3

1. Visual approval on real devices first (iPhone Safari, Android Chrome, desktop
   Safari/Chrome/Firefox) using the prototype URL; tune exploded offsets and camera
   keys with `?debug=1`.
2. Textures: build from the 4K originals; test 2K base colour + 2K normal + 1K
   metal/rough on desktop and 1K/2K/1K on mobile; keep JPEG 4:4:4 for normal and
   metal/rough (WebP 4:2:0 corrupts them). Target: GLB ≤ 1.6 MB desktop, ≤ 1.0 MB
   mobile, texture memory ≤ 35 MB mobile.
3. Groups: split the contact barrel's outer nut/washers and the under-frame screws
   (19–20 groups) to remove the last visible pass-throughs.
4. Integration in `index.html`: replace `#machine-section` and the fixed
   `#machine-bg`; drop GSAP/ScrollTrigger from the homepage (the prototype does not
   need them); add `GLTFLoader.js` and `RoomEnvironment.js` to
   `scripts/vendor-3d-libs.mjs` with pinned hashes; exclude the new section from
   `components.js` `.reveal` (blur/transform) and resolve the hero parallax
   stacking context (`components.js:776`) so hero text stays above the canvas.
5. Keep the poster as the fallback and pre-load state; generate posters in the build
   from the same scene (`window.__machine.capture`).
6. Decide raw-source storage (SR-003): separate private repository, or keep local.
   `source-assets/` is gitignored because Cloudflare Pages publishes the repository
   root.
7. Verify on the production URL whether Cloudflare compresses `model/gltf-binary`;
   if not, the geometry costs 732 KB instead of ≈ 300 KB.
