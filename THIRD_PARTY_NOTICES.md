# Third-Party Notices

This file lists third-party software vendored into this repository under
`assets/vendor/`.

## Three.js

- **Package:** `three`
- **Version:** `0.128.0`
- **Source:** https://registry.npmjs.org/three/-/three-0.128.0.tgz (npm)
- **License:** MIT
- **License file:** the package-provided `LICENSE` file is vendored unchanged
  at `assets/vendor/three/0.128.0/LICENSE`.
- **Vendored files:**
  - `assets/vendor/three/0.128.0/three.min.js` (from `node_modules/three/build/three.min.js`)
  - `assets/vendor/three/0.128.0/LICENSE` (from `node_modules/three/LICENSE`)

## GSAP / ScrollTrigger

- **Package:** `gsap`
- **Version:** `3.12.5`
- **Source:** https://registry.npmjs.org/gsap/-/gsap-3.12.5.tgz (npm)
- **Official license URL:** https://gsap.com/standard-license
- **License note:** the `gsap` npm package does not ship a standalone
  `LICENSE` file. Its `package.json` `license` field reads: "Standard 'no
  charge' license: https://gsap.com/standard-license. Club GSAP members get
  more: https://gsap.com/licensing/. Why GreenSock doesn't employ an MIT
  license: https://gsap.com/why-license/". The copyright and license header
  comment embedded in each distributed file (`Copyright 2024, GreenSock. All
  rights reserved. Subject to the terms at https://gsap.com/standard-license
  ...`) is preserved unmodified in the vendored copies below. This notice
  states these facts only; it does not draw a conclusion about license
  suitability for any particular use — usage of GSAP remains subject to the
  official GSAP license terms at the URL above.
- **Vendored files:**
  - `assets/vendor/gsap/3.12.5/gsap.min.js` (from `node_modules/gsap/dist/gsap.min.js`)
  - `assets/vendor/gsap/3.12.5/ScrollTrigger.min.js` (from `node_modules/gsap/dist/ScrollTrigger.min.js`)

## Provenance

All files above were copied byte-for-byte from the pinned npm package
versions by `scripts/vendor-3d-libs.mjs`, which verifies each source file's
SHA-256 hash against a hardcoded expected value before writing. Run `npm run
vendor:3d-libs:check` to re-verify the committed files at any time.
