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

## Workflow inputs and targeted runs

`optimize:images` supports these environment variables (all optional):

- `IMAGE_ROOT` (default: `assets`) — folder root to scan.
- `IMAGE_LIMIT` (default: `15`) — number of largest images to optimize.
- `GENERATE_WEBP` (default: `true`) — set to `false` to skip WebP generation.
- `GENERATE_AVIF` (default: `true`) — set to `false` to skip AVIF generation.
- `FORCE` (default: `false`) — set to `true` to regenerate derivatives even when existing derivatives are newer than the source image.

Example: optimize homepage portfolio thumbnails only

- `IMAGE_ROOT=assets/portfolio`
- `IMAGE_LIMIT=20`
- `GENERATE_WEBP=true`
- `GENERATE_AVIF=false`

Local command example:

```bash
IMAGE_ROOT=assets/portfolio IMAGE_LIMIT=20 GENERATE_WEBP=true GENERATE_AVIF=false npm run optimize:images
```

## AVIF serving status

AVIF generation remains available in tooling, but AVIF is currently **not served on the site** due to previous production serving issues. Keep AVIF serving disabled until a dedicated validation rollout is completed.

## Markup allowlist note

Expand any markup allowlist for optimized formats only after WebP files already exist for the targeted images and preview/testing confirms gallery behavior is stable.
