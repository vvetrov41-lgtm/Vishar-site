# Image Optimization Report (Phase 1A)

## Scope
Top 15 largest raster images under `assets/` were selected.

## Environment result
This execution environment cannot fetch package/system dependencies required to generate WebP/AVIF derivatives:
- `npm install sharp` failed with `403 Forbidden` (registry access blocked).
- `apt-get` installation of image CLI tools failed with `403 Forbidden` via proxy.

Because no local image conversion engine is available, no WebP/AVIF derivatives were generated in this pass.

## Before/After table (requested set)

| Image | Original bytes | WebP bytes | AVIF bytes | Status |
|---|---:|---:|---:|---|
| assets/cover-ups/after-04.jpg | 17,804,413 | n/a | n/a | skipped (tooling unavailable) |
| assets/cover-ups/after-02.jpg | 15,772,580 | n/a | n/a | skipped (tooling unavailable) |
| assets/cover-ups/after-05.jpg | 14,366,223 | n/a | n/a | skipped (tooling unavailable) |
| assets/black-grey/05.jpg | 14,245,933 | n/a | n/a | skipped (tooling unavailable) |
| assets/cover-ups/before-03.jpg | 13,941,750 | n/a | n/a | skipped (tooling unavailable) |
| assets/portfolio/08.jpg | 13,066,147 | n/a | n/a | skipped (tooling unavailable) |
| assets/colour-realism/04.jpg | 13,066,147 | n/a | n/a | skipped (tooling unavailable) |
| assets/black-grey/04.jpg | 10,951,052 | n/a | n/a | skipped (tooling unavailable) |
| assets/cover-ups/before-01.jpg | 10,520,226 | n/a | n/a | skipped (tooling unavailable) |
| assets/black-grey/03.jpeg | 10,002,875 | n/a | n/a | skipped (tooling unavailable) |
| assets/black-grey/08.jpg | 9,897,583 | n/a | n/a | skipped (tooling unavailable) |
| assets/portfolio/20.jpg | 9,724,153 | n/a | n/a | skipped (tooling unavailable) |
| assets/colour-realism/01.jpg | 9,724,153 | n/a | n/a | skipped (tooling unavailable) |
| assets/cover-ups/before-04.jpg | 8,990,559 | n/a | n/a | skipped (tooling unavailable) |
| assets/cover-ups/after-01.jpg | 8,699,537 | n/a | n/a | skipped (tooling unavailable) |

## Pages referencing selected images
- `index.html` (portfolio array references `08.jpg` and `20.jpg`)
- `cover-up-tattoo-manchester/index.html` (before/after pairs include selected cover-up files)
- `black-and-grey-realism-manchester/index.html` (gallery script dynamically resolves `03.jpeg`, `04.jpg`, `05.jpg`, `08.jpg`)
- `colour-realism-tattoo-manchester/index.html` (gallery script dynamically resolves `01.jpg`, `04.jpg`)

## Next step to complete Phase 1A
Run in a network-enabled dev environment with either:
1. Node + `sharp`, or
2. `cwebp` + `avifenc` / ImageMagick.

Then regenerate this report with actual optimized sizes and update markup to `<picture>` + AVIF/WebP fallbacks for affected entries.
