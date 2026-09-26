# Tasks: Homepage tattoo machine assembly sequence

## Rules

- Every implementation task traces to requirements in `spec.md` or sections in `plan.md`.
- Do not mark deployment complete from code or CI evidence alone.

## Phase 0: Preflight

- [x] T001 Branch `claude/tattoo-machine-3d-analysis-l5voti` created from `origin/main` `4dd40fe`; working tree clean before implementation.
- [x] T002 Current-state evidence recorded in `plan.md` (3D block, CSP, Pages publishing, validator behaviour).
- [x] T003 Source model verified: 2K analysis GLB geometry identical to FBX; 59 parts; 18 groups.

## Phase 1: Asset pipeline

- [x] T010 `scripts/machine-model/machine-groups.json`: signature map for 59 parts → 18 groups, pivot rules [FR-001, FR-002]
- [x] T011 `scripts/machine-model/build-machine-glb.mjs`: islands, grouping, pivots, textures, quantize, pivots JSON, `--check` [FR-001, FR-012]
- [x] T012 Keep raw purchased sources out of published paths (`.gitignore` for `source-assets/`) [SR-003]

## Phase 2: Prototype

- [x] T020 `prototypes/machine-assembly/index.html`: hero copy with Featured-in inside the hero, sequence section, Portfolio stub, `noindex` [FR-008, FR-009, SR-002]
- [x] T021 Timeline data: windows, landscape/portrait exploded offsets, rotations, screw turns [FR-002–FR-005]
- [x] T022 Scroll driver with damping, on-demand rendering, IO/visibility gating [FR-007, FR-010]
- [x] T023 Camera keyframes, lighting, hero moment, push-in and upright wipe [FR-006]
- [x] T024 Deferred init, poster fallback, reduced motion, context loss, skip control [FR-011, Scenario 3–5]
- [x] T025 Debug mode: progress slider, stage label, pivot helpers, stats [AC-003]

## Phase 3: Validation

- [x] T030 Validator rule for `prototypes/` pages (noindex, not in sitemap) and green `validate:site` [AC-005]
- [x] T031 Assembly path clearance sweep and report [AC-002]
- [x] T032 Storyboard screenshots desktop and mobile [AC-001]
- [x] T033 Draw calls out of view = 0; load size, triangles, draw calls, texture memory recorded [AC-004]
- [x] T034 Production files byte-identical to `4dd40fe` [AC-006]

## Phase 4: Convergence

- [x] T040 `PHASE2_REPORT.md`: intersections, pivots, performance, Phase 3 recommendations
- [x] T041 Converge spec/plan/tasks with implementation evidence

## Phase 5: Environment rollout, only when authorized

- [ ] T050 Phase 3 integration PR (requires owner approval)
- [ ] T051 Real-device QA (iPhone Safari, Android Chrome, desktop Safari/Chrome/Firefox)
- [ ] T052 Production deploy and verification (requires owner approval)

## Evidence

- T011: `build-machine-glb.mjs --check` → 59 parts, 18 groups, 39 988 triangles, geometry 732 KB.
- T030: `npm run validate:site` → 34 passed, 0 failures; negative test (noindex removed) fails as expected.
- T031: `evidence/assembly-paths.json`; mid-air collisions: none; remaining contacts classified in `PHASE2_REPORT.md`.
- T032: `evidence/storyboard-desktop.jpg`, `evidence/storyboard-mobile.jpg`, `evidence/pivots-debug.jpg`.
- T033: `evidence/runtime-metrics.json`; 0 frames out of view, 0 frames idle, 0 3D requests at initial load.
- T034: `git diff 4dd40fe -- index.html _headers components.js assets/vendor` is empty.

## Deferred work

- [ ] D001 4K-sourced production export and texture budget tuning - Reason: owner deferred texture optimisation to after visual approval.
- [ ] D002 Storage location for raw purchased sources - Reason: Pages publishes the repository root; needs owner decision.
- [ ] D003 Split contact-barrel outer nut/washers and under-frame screws into their own groups - Reason: last visible pass-throughs (PHASE2_REPORT.md).
- [ ] D004 Real-device GPU timing and memory (iPhone Safari, Android Chrome) - Reason: SwiftShader is not representative.
