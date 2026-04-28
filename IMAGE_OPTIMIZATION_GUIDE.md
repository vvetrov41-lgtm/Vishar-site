# Image Optimization Guide (Phase 1A Tooling)

This repository now includes a reproducible optimization workflow for generating sidecar WebP/AVIF files for the largest source images.

## What this workflow does

- Scans `assets/` recursively.
- Targets raster sources only (`.jpg`, `.jpeg`, `.JPG`, `.JPEG`, `.png`, `.PNG`).
- Ignores SVG/WebP/AVIF source files.
- Sorts by file size descending.
- Optimizes the top **15** by default (override with `IMAGE_LIMIT`).
- Generates:
  - `original-name.webp`
  - `original-name.avif`
- Keeps original JPG/PNG files unchanged.
- Writes:
  - `IMAGE_OPTIMIZATION_REPORT.json`
  - `IMAGE_OPTIMIZATION_REPORT.md`

## Run from GitHub web UI

1. Open the repository on GitHub.
2. Go to **Actions**.
3. Open workflow **Optimize Images**.
4. Click **Run workflow** and choose the target branch.
5. Wait for completion.
6. Download artifacts (`IMAGE_OPTIMIZATION_REPORT.md`, `IMAGE_OPTIMIZATION_REPORT.json`) from the run summary.
7. If generated files changed, the workflow commits `.webp`, `.avif`, and report updates back to that branch.

## Run locally

```bash
npm install
npm run optimize:images
```

Optional controls:

```bash
IMAGE_LIMIT=30 npm run optimize:images
FORCE=true npm run optimize:images
```

- `IMAGE_LIMIT` changes how many largest files are optimized.
- `FORCE=true` regenerates derivatives even if existing optimized files are newer than originals.

## Important implementation boundary

- This phase prepares and runs image derivative generation only.
- **Do not delete originals**.
- **Do not update HTML markup in this phase**.
- `<picture>` / `srcset` / `sizes` markup updates should be handled in a separate follow-up phase after optimized files are present.
