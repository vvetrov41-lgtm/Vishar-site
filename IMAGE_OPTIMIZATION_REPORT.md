# Image Optimization Report

- Generated at: 2026-05-05T05:44:27.682Z
- Source directory: assets/colour-realism
- Image limit: 20
- FORCE mode: true
- Generate WebP: true
- Generate AVIF: true
- Resize threshold: 2400px
- WebP quality: 85
- AVIF quality: 50

## Summary

- Candidates scanned: 12
- Optimized set: 12
- Derivatives written: 24
- Derivatives skipped (up-to-date): 0
- Original total: 35.32 MB
- WebP total: 2.75 MB
- AVIF total: 683.63 KB

## Per-file results

| File | Original | WebP | AVIF | Resize | Status |
|---|---:|---:|---:|---:|---|
| assets/colour-realism/04.jpg | 12.46 MB | 254.06 KB | 81.98 KB | 6039→2400 | generated/updated |
| assets/colour-realism/01.jpg | 9.27 MB | 217.65 KB | 56.22 KB | 4277→2400 | generated/updated |
| assets/colour-realism/09.jpg | 3.93 MB | 176.59 KB | 41.02 KB | 3024→2400 | generated/updated |
| assets/colour-realism/12.jpg | 1.76 MB | 180.54 KB | 55.11 KB | 4041→2400 | generated/updated |
| assets/colour-realism/06.jpg | 1.69 MB | 636.12 KB | 79.52 KB | 1979 | generated/updated |
| assets/colour-realism/10.jpg | 1.67 MB | 302.30 KB | 78.30 KB | 2768→2400 | generated/updated |
| assets/colour-realism/03.jpg.JPG | 1.20 MB | 104.98 KB | 30.69 KB | 1365 | generated/updated |
| assets/colour-realism/08.jpg | 1.03 MB | 220.47 KB | 65.61 KB | 2610→2400 | generated/updated |
| assets/colour-realism/07.jpg | 1.03 MB | 288.46 KB | 90.54 KB | 2287 | generated/updated |
| assets/colour-realism/05.jpg | 703.64 KB | 121.79 KB | 32.55 KB | 1920 | generated/updated |
| assets/colour-realism/11.jpg | 303.63 KB | 72.84 KB | 23.92 KB | 1417 | generated/updated |
| assets/colour-realism/02.jpg | 294.74 KB | 241.55 KB | 48.18 KB | 1706 | generated/updated |

## Notes

- Original JPG/PNG files are preserved and never overwritten.
- This workflow only creates sidecar `.webp` and/or `.avif` files.
- Existing newer derivatives are skipped unless `FORCE=true`.
- HTML `<picture>` migration should happen in a separate implementation phase.

## Update – 2026-05-05

- Colour-realism WebP thumbnail serving enabled only for files with confirmed .webp sidecars. AVIF and lightbox optimization remain disabled.

- 2026-05-05 follow-up: explicit colour-realism candidate list now includes `03.jpg.JPG` with `03.jpg.webp` sidecar mapping for thumbnail WebP delivery.
