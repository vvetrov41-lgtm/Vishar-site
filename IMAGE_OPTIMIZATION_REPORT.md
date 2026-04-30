# Image Optimization Report

- Generated at: 2026-04-28T23:37:10.718Z
- Source directory: assets
- Image limit: 15
- FORCE mode: false
- Resize threshold: 2400px
- WebP quality: 85
- AVIF quality: 50

## Summary

- Candidates scanned: 65
- Optimized set: 15
- Derivatives written: 30
- Derivatives skipped (up-to-date): 0
- Original total: 172.40 MB
- WebP total: 4.58 MB
- AVIF total: 1.11 MB

## Per-file results

| File | Original | WebP | AVIF | Resize | Status |
|---|---:|---:|---:|---:|---|
| assets/cover-ups/after-04.jpg | 16.98 MB | 373.52 KB | 61.40 KB | 4672→2400 | generated/updated |
| assets/cover-ups/after-02.jpg | 15.04 MB | 319.38 KB | 69.58 KB | 4672→2400 | generated/updated |
| assets/cover-ups/after-05.jpg | 13.70 MB | 291.36 KB | 78.35 KB | 5343→2400 | generated/updated |
| assets/black-grey/05.jpg | 13.59 MB | 179.57 KB | 55.13 KB | 6048→2400 | generated/updated |
| assets/cover-ups/before-03.jpg | 13.30 MB | 275.08 KB | 80.77 KB | 6048→2400 | generated/updated |
| assets/colour-realism/04.jpg | 12.46 MB | 254.06 KB | 81.98 KB | 6039→2400 | generated/updated |
| assets/portfolio/08.jpg | 12.46 MB | 254.06 KB | 81.98 KB | 6039→2400 | generated/updated |
| assets/black-grey/04.jpg | 10.44 MB | 167.96 KB | 51.83 KB | 6048→2400 | generated/updated |
| assets/cover-ups/before-01.jpg | 10.03 MB | 542.57 KB | 150.11 KB | 3712→2400 | generated/updated |
| assets/black-grey/03.jpeg | 9.54 MB | 331.05 KB | 61.20 KB | 4672→2400 | generated/updated |
| assets/black-grey/08.jpg | 9.44 MB | 246.33 KB | 81.58 KB | 5040→2400 | generated/updated |
| assets/colour-realism/01.jpg | 9.27 MB | 217.65 KB | 56.22 KB | 4277→2400 | generated/updated |
| assets/portfolio/20.jpg | 9.27 MB | 217.65 KB | 56.22 KB | 4277→2400 | generated/updated |
| assets/cover-ups/before-04.jpg | 8.57 MB | 291.41 KB | 88.23 KB | 6048→2400 | generated/updated |
| assets/cover-ups/after-01.jpg | 8.30 MB | 732.34 KB | 79.34 KB | 3072→2400 | generated/updated |

## Notes

- Original JPG/PNG files are preserved and never overwritten.
- This workflow only creates sidecar `.webp` and `.avif` files.
- HTML `<picture>` migration should happen in a separate implementation phase.


## Phase 1A serving update (2026-04-29)

> Superseded by emergency rollback on 2026-04-29.



## Emergency rollback: optimized serving disabled

Optimized .webp/.avif derivatives remain in the repository, but gallery serving has been rolled back to direct JPG/JPEG paths because the AVIF/WebP serving implementation caused production image loading issues.

Current production serving behavior:
- direct JPG/JPEG/PNG paths only
- no <picture>
- no AVIF/WebP source selection
- no async optimized resolver

- Pilot WebP serving enabled only for homepage portfolio thumbnails 08 and 20. AVIF and lightbox optimization remain disabled pending manual visual testing.
