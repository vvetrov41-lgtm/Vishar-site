# Image Optimization Report

- Generated at: 2026-04-30T07:13:39.305Z
- Source directory: assets/portfolio
- Image limit: 20
- FORCE mode: false
- Generate WebP: true
- Generate AVIF: false
- Resize threshold: 2400px
- WebP quality: 85
- AVIF quality: 50

## Summary

- Candidates scanned: 20
- Optimized set: 20
- Derivatives written: 18
- Derivatives skipped (up-to-date): 2
- Original total: 61.97 MB
- WebP total: 4.76 MB
- AVIF total: 0 B

## Per-file results

| File | Original | WebP | AVIF | Resize | Status |
|---|---:|---:|---:|---:|---|
| assets/portfolio/08.jpg | 12.46 MB | 254.06 KB (skip) | disabled | 6039→2400 | skipped (up-to-date) |
| assets/portfolio/20.jpg | 9.27 MB | 217.65 KB (skip) | disabled | 4277→2400 | skipped (up-to-date) |
| assets/portfolio/17.jpg | 7.88 MB | 267.70 KB | disabled | 2539→2400 | generated/updated |
| assets/portfolio/18.jpg | 5.90 MB | 218.85 KB | disabled | 2446→2400 | generated/updated |
| assets/portfolio/10.jpg | 4.89 MB | 227.16 KB | disabled | 3024→2400 | generated/updated |
| assets/portfolio/05.jpg | 3.93 MB | 176.59 KB | disabled | 3024→2400 | generated/updated |
| assets/portfolio/15.jpg | 3.01 MB | 271.91 KB | disabled | 4249→2400 | generated/updated |
| assets/portfolio/12.jpg | 1.76 MB | 180.54 KB | disabled | 4041→2400 | generated/updated |
| assets/portfolio/13.jpg | 1.73 MB | 163.24 KB | disabled | 4586→2400 | generated/updated |
| assets/portfolio/02.jpg | 1.69 MB | 636.12 KB | disabled | 1979 | generated/updated |
| assets/portfolio/06.jpg | 1.67 MB | 302.30 KB | disabled | 2768→2400 | generated/updated |
| assets/portfolio/19.jpg | 1.53 MB | 523.28 KB | disabled | 2172 | generated/updated |
| assets/portfolio/16.jpg | 1.09 MB | 249.47 KB | disabled | 2624→2400 | generated/updated |
| assets/portfolio/14.jpg | 1.03 MB | 220.47 KB | disabled | 2610→2400 | generated/updated |
| assets/portfolio/07.jpg | 1.03 MB | 288.46 KB | disabled | 2287 | generated/updated |
| assets/portfolio/03.jpg | 954.37 KB | 178.66 KB | disabled | 2247 | generated/updated |
| assets/portfolio/11.jpg | 878.15 KB | 173.39 KB | disabled | 2373 | generated/updated |
| assets/portfolio/01.jpg | 703.64 KB | 121.79 KB | disabled | 1920 | generated/updated |
| assets/portfolio/09.jpg | 313.20 KB | 134.19 KB | disabled | 1034 | generated/updated |
| assets/portfolio/04.jpg | 303.63 KB | 72.84 KB | disabled | 1417 | generated/updated |

## Notes

- Original JPG/PNG files are preserved and never overwritten.
- This workflow only creates sidecar `.webp` and/or `.avif` files.
- Existing newer derivatives are skipped unless `FORCE=true`.
- HTML `<picture>` migration should happen in a separate implementation phase.


## Update – 2026-04-30

- Homepage WebP pilot was expanded to all 20 homepage portfolio card images (`assets/portfolio/01.jpg` through `20.jpg`) via the existing safe allowlist pattern in `index.html`.
- Homepage lightbox behavior remains unchanged and JPG-only.
- AVIF remains disabled/not used.
