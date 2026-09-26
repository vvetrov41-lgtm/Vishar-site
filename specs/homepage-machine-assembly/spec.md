# Feature Specification: Homepage tattoo machine assembly sequence

## Status

- Feature: `homepage-machine-assembly`
- State: Phase 2 converged (isolated prototype); Phase 3 awaits owner visual approval
- Owner/workstream: Claude Code session, branch `claude/tattoo-machine-3d-analysis-l5voti`
- Related PRs/issues: none (owner instruction: no PR during Phase 2)

## Problem

The homepage 3D section (`index.html` `#machine-section`) renders a procedural
primitive-based "tattoo machine" that reads as a technical demo rather than a
product film. Observed defects at `4dd40fe`:

- the WebGL canvas sits in a fixed full-viewport layer that stays visible and keeps
  rendering (continuous `requestAnimationFrame` with auto-rotation) behind Portfolio,
  About, Gallery, Aftercare, Reviews and FAQ until `#ai-assistant` leaves the viewport;
- the sticky label layer does not stick because the section has `overflow:hidden`;
- the whole assembly happens in about 470 px of scroll;
- mobile rendering is capped at DPR 1.25 without antialiasing;
- the unsupported/weak-device fallback is a text message, not an image.

The owner purchased a real coil tattoo machine model (CGTrader). Phase 1 analysis
(recorded in `plan.md`) proved it contains 59 physically separate parts that can be
grouped into 18 mechanically meaningful animation groups without Blender.

## Goals

- Replace the procedural scene with the purchased model, shown as a short product
  film: controlled exploded state, mechanically plausible assembly, a brief hero
  moment, a cinematic camera push-in, and a continuous transition into Portfolio.
- Keep Portfolio the primary content: the sequence must not hold the visitor for
  several screens.
- Keep the hero (H1, CTAs, LCP image) static HTML.

## Non-goals

- Changing the Content-Security-Policy (no `'wasm-unsafe-eval'`, no blob workers).
- Meshopt, Draco or KTX2/Basis compression (all require WebAssembly under the
  current CSP).
- Upgrading Three.js beyond the vendored r128 in this feature.
- Texture-size optimisation beyond straightforward encoding (deferred to Phase 3/4).
- Redesigning the hero, Portfolio or any other homepage section.
- Production integration during Phase 2.

## Actors and scope

- User/actor: anonymous homepage visitor on desktop or mobile.
- Artist/workspace scope: N/A (public static marketing page).
- Environments affected: Phase 2: local and branch only. Phase 3+: production
  homepage, only after explicit owner approval.

## User scenarios

### Scenario 1: Desktop visitor scrolls from the hero

Given the homepage has rendered its static hero, when the visitor scrolls down, then
parts of the disassembled machine rise out of the hero's bottom black gradient, the
machine assembles group by group as the visitor keeps scrolling, holds briefly as a
finished instrument, the camera pushes in until the dark frame upright fills the
frame, and the Portfolio heading follows without any intermediate section.

### Scenario 2: Mobile visitor

Given a phone viewport, when the visitor performs roughly one normal swipe past the
hero, then the full sequence (assembly, hero moment, push-in) completes within about
100–120 vh of scroll and Portfolio follows.

### Scenario 3: Visitor skips the sequence

Given the visitor is on the hero or inside the sequence, when they activate
"View Work" (hero) or the in-sequence skip control, then they land on Portfolio
immediately and no scroll-scrubbed animation blocks them.

### Scenario 4: WebGL unavailable, data saver, weak device, load failure

Given WebGL cannot be created, the model fails to load, `saveData` is on, or the
device matches the weak-device heuristics, then a static poster image of the machine
is shown instead, the section does not reserve extra scroll length, and no WebGL work
is attempted.

### Scenario 5: Reduced motion

Given `prefers-reduced-motion: reduce`, then the assembled machine is shown as a
single static frame (or poster) and the section does not reserve extra scroll length.

## Functional requirements

- FR-001: The sequence MUST use the purchased model split into 18 semantic groups
  (see `plan.md` group table); every one of the 59 source parts MUST belong to exactly
  one group.
- FR-002: Each group MUST animate about a defined pivot (bbox centre, mechanical axis
  or hinge) along a defined assembly direction; screws MUST translate along their own
  axis and rotate about it.
- FR-003: The order MUST follow: frame, tube stem and needle → coils → capacitor →
  upper mechanism (armature bar, spring, contact barrel and screw) → grip and tip
  (sliding up around the needle) → fine hardware, wiring and rubber bands → hero
  moment → push-in. No part may pass through another part's surface before its
  final seating move, verified by the assembly path sweep.
- FR-004: Wiring and rubber bands MUST NOT fly as rigid bodies; they appear with a
  short fade and small settle.
- FR-005: The exploded composition MUST stay inside the viewport safe area on both
  landscape (desktop) and portrait (mobile) layouts, with separate offset tables.
- FR-006: The camera push-in MUST end with the frame upright covering the lens and
  the image darkening to black before Portfolio begins.
- FR-007: Scroll length owned by the sequence MUST be about 100–120 vh on mobile and
  120–160 vh on desktop, excluding the hero itself.
- FR-008: The sequence MUST begin visually inside the hero's bottom gradient while the
  hero remains static HTML and its LCP element is unchanged.
- FR-009: "Featured in …" MUST live inside the hero near its bottom; nothing may be
  inserted between the sequence and Portfolio.
- FR-010: Rendering MUST be on demand (only when scroll progress, damping or
  resize changes the frame) and MUST stop completely when the section is out of view
  or the document is hidden.
- FR-011: WebGL initialisation and model download MUST NOT start during initial page
  load; they start on the first user scroll or when the page is idle after `load`.
- FR-012: The prototype MUST run on the vendored Three.js r128 global build plus
  r128 `GLTFLoader` and `RoomEnvironment` from `examples/js`, without WebAssembly.

## Security and trust requirements

- SR-001: No CSP relaxation. All scripts, the model and textures are same-origin
  static files compatible with the current `_headers` policy.
- SR-002: The prototype page MUST be `noindex`, excluded from `sitemap.xml`, and
  not linked from any production page.
- SR-003: Raw purchased source files (FBX/OBJ/DAE/original GLB/PNG textures) MUST NOT
  be committed to a path that Cloudflare Pages publishes. The repository root is the
  Pages output directory (observed: `https://vishartattoo.com/AGENTS.md` returns
  200), so repository privacy does not keep committed files private.

## Failure and recovery behavior

- Model or texture request failure: keep the poster, log one console warning, never
  retry in a loop.
- WebGL context loss: stop rendering, show the poster; do not recreate a context
  automatically.
- Resize/orientation change: debounce; ignore height-only changes below 120 px
  (mobile URL bar) to avoid drawing-buffer reallocation during scroll.

## Data and retention expectations

N/A: no user data, no storage, no network calls beyond same-origin static assets.

## Acceptance criteria

- AC-001: Screenshots of the prototype at the storyboard stages (A–I) on desktop
  (1440×900) and mobile (390×844) show a readable exploded composition, correct seat
  positions after assembly, and a push-in that ends on the dark upright.
- AC-002: An automated sweep reports, for every group, the minimum clearance to
  already-placed groups along its assembly path; any penetration before the final seat
  is listed with the group, progress and depth.
- AC-003: The pivot table lists, for every group, pivot position, motion axis and
  rotation axis, and the prototype debug mode can display them.
- AC-004: No draw calls occur while the section is out of view (measured).
- AC-005: `npm run validate:site` passes with the prototype present.
- AC-006: The production homepage (`index.html`, `_headers`, `components.js`,
  `assets/vendor/*`) is byte-identical to `4dd40fe` at the end of Phase 2.

## Dependencies and constraints

- Three.js r128 (vendored), no WebAssembly, current CSP.
- Source model: CGTrader purchase; analysis copy with 2K textures for Phase 2, 4K
  original for the final production export.
- Cloudflare Pages publishes the repository root.

## Open questions

- Where to keep raw purchased sources given SR-003 (separate private repository,
  gitignored local copy, or a Pages output directory change).
- Whether Cloudflare Pages branch preview deployments are enabled for this project
  (requires dashboard access; not verifiable from this session).

## Requirement changes

- 2026-09-26: Owner rejected CSP change; Meshopt/KTX2 removed, geometry is
  quantize-only (`KHR_mesh_quantization`).
- 2026-09-26: Owner moved "Featured in" into the hero and required a continuous
  sequence → Portfolio transition.
- 2026-09-26: The needle moved from the lower-column stage to stage B. The path
  sweep showed that a 20 cm needle hovering above its seat always crosses the
  armature seat; grip and tip now slide up around the seated needle.
