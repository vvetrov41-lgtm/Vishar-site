# Third-Party Notices

This file lists third-party software vendored into this repository.

## GEO Topic Agent

- **Package:** `geo-topic-agent-runtime`
- **Version:** `1.4.0`
- **Source:** user-provided distribution archive
- **Purpose:** repository-scoped GEO/AEO research and planning runtime for Codex
- **Installed paths:** `.geo-topic-agent-runtime/` and `.agents/skills/`
- **License:** GEO Topic Agent Usage License 1.0
- **License file:** `.geo-topic-agent-runtime/LICENSE.md`
- **Local compatibility patch:** the installed copy corrects the reviewed-plan
  keyword passed by `setup_environment()` to `apply_runtime_adaptation()`;
  attribution and license enforcement are unchanged.

Use of this runtime remains subject to its attribution and redistribution
conditions. It is development tooling and is not loaded by the public website.

Three.js (`three` 0.128.0) and GSAP/ScrollTrigger (`gsap` 3.12.5) were
previously vendored under `assets/vendor/` for the homepage 3D tattoo machine.
That section is now a scroll-scrubbed video clip driven by plain DOM APIs, so
both libraries, their vendored files, and `scripts/vendor-3d-libs.mjs` have
been removed. No third-party runtime JavaScript remains vendored in this
repository.

## Fonts

The following are latin-subset, static, roman-only WOFF2 font files, each
repackaged unmodified by the corresponding pinned `@fontsource/*` npm
package from its upstream font project. Only the specific weight(s) the
site actually renders are vendored — see `assets/css/fonts.css` and
`assets/css/fonts-book.css` for where each face is used.

### Inter

- **Package:** `@fontsource/inter`
- **Version:** `5.2.8`
- **Source:** https://registry.npmjs.org/@fontsource/inter/-/inter-5.2.8.tgz (npm)
- **Upstream font project:** https://github.com/rsms/inter
- **License:** SIL Open Font License, Version 1.1
- **Copyright:** Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)
- **License file:** the package-provided `LICENSE` file is vendored unchanged
  at `assets/vendor/fonts/inter/5.2.8/LICENSE`.
- **Vendored files:**
  - `assets/vendor/fonts/inter/5.2.8/inter-latin-300-normal.woff2`
  - `assets/vendor/fonts/inter/5.2.8/inter-latin-400-normal.woff2`
  - `assets/vendor/fonts/inter/5.2.8/inter-latin-500-normal.woff2`
  - `assets/vendor/fonts/inter/5.2.8/inter-latin-600-normal.woff2`
  - `assets/vendor/fonts/inter/5.2.8/LICENSE`

### Playfair Display

- **Package:** `@fontsource/playfair-display`
- **Version:** `5.2.8`
- **Source:** https://registry.npmjs.org/@fontsource/playfair-display/-/playfair-display-5.2.8.tgz (npm)
- **Upstream font project:** https://github.com/clauseggers/Playfair-Display
- **License:** SIL Open Font License, Version 1.1
- **Copyright:** Copyright 2017 The Playfair Display Project Authors
  (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name
  "Playfair Display"
- **License file:** the package-provided `LICENSE` file is vendored unchanged
  at `assets/vendor/fonts/playfair-display/5.2.8/LICENSE`.
- **Vendored files:**
  - `assets/vendor/fonts/playfair-display/5.2.8/playfair-display-latin-700-normal.woff2`
  - `assets/vendor/fonts/playfair-display/5.2.8/LICENSE`

### Bodoni Moda

- **Package:** `@fontsource/bodoni-moda`
- **Version:** `5.2.7`
- **Source:** https://registry.npmjs.org/@fontsource/bodoni-moda/-/bodoni-moda-5.2.7.tgz (npm)
- **Upstream font project:** https://github.com/indestructible-type/Bodoni
- **License:** SIL Open Font License, Version 1.1
- **Copyright:** Copyright 2020 The Bodoni Moda Project Authors
  (https://github.com/indestructible-type/Bodoni)
- **License file:** the package-provided `LICENSE` file is vendored unchanged
  at `assets/vendor/fonts/bodoni-moda/5.2.7/LICENSE`.
- **Vendored files:**
  - `assets/vendor/fonts/bodoni-moda/5.2.7/bodoni-moda-latin-500-normal.woff2`
  - `assets/vendor/fonts/bodoni-moda/5.2.7/LICENSE`

### IBM Plex Mono

- **Package:** `@fontsource/ibm-plex-mono`
- **Version:** `5.2.7`
- **Source:** https://registry.npmjs.org/@fontsource/ibm-plex-mono/-/ibm-plex-mono-5.2.7.tgz (npm)
- **Upstream font project:** https://github.com/IBM/plex
- **License:** SIL Open Font License, Version 1.1
- **Copyright:** Copyright 2017 IBM Corp. All rights reserved.
- **License file:** the package-provided `LICENSE` file is vendored unchanged
  at `assets/vendor/fonts/ibm-plex-mono/5.2.7/LICENSE`.
- **Vendored files:**
  - `assets/vendor/fonts/ibm-plex-mono/5.2.7/ibm-plex-mono-latin-400-normal.woff2`
  - `assets/vendor/fonts/ibm-plex-mono/5.2.7/LICENSE`

## Provenance

All files under "Fonts" above were copied byte-for-byte from the pinned npm
package versions by `scripts/vendor-fonts.mjs`, which verifies each source
file's SHA-256 hash against a hardcoded expected value before writing. Run
`npm run vendor:fonts:check` to re-verify the committed files at any time.
