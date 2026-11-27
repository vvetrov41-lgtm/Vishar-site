# Homepage 3D startup performance patch

Evidence: Lighthouse 12.6.0 mobile three-run baseline, https://github.com/vvetrov41-lgtm/Vishar-Engineering/actions/runs/45972132072. Median TBT 13,260 ms; score 59; LCP 3,422 ms; transfer 4,128,292 bytes. Long tasks attributed to machine-assembly.js (10,000 ms in each trace); the 3,155,592-byte model and Three.js were requested with no scroll. LCP element is hero.webp, not the 3D model.

Hypothesis: the load + idle callback performs WebGL probing and starts 3D even for users who stay on the hero; removing that automatic path should eliminate the heavy unrequested work. The 3D effect must stay available, not be removed to improve the score.

Patch plan: display existing lightweight poster, defer normal 3D initiation until scrolling at least 48 CSS pixels; preserve explicit diagnostics and immediate reduced-motion/data-saver fallback; cache-bust the loader. No changes to the model, scene, animations, design, analytics or booking. Regression tests cover no idle startup, one-shot meaningful scroll, reduced motion, data saver, forced/static and unavailable WebGL. Re-run static CI and independent review, measure candidate Lighthouse on an exact preview, then compare the deployed revision using the same three-run mobile settings. Measure post-scroll experience separately; initial-load TBT alone does not prove responsive interactive rendering.

No field data available from PageSpeed API (429). Production rollout is not proven by this PR.
