# Machine assembly sequence — isolated prototype

Phase 2 prototype for `specs/homepage-machine-assembly/`. Not linked from the
site, `noindex`, excluded from `sitemap.xml` (enforced by
`npm run validate:site`). Production files are untouched.

## Run locally

Serve the repository root with any static server and open
`/prototypes/machine-assembly/`:

```bash
python3 -m http.server 8080   # then http://localhost:8080/prototypes/machine-assembly/
```

Query flags (prototype only):

| Flag | Effect |
| --- | --- |
| `?debug=1` | debug panel: position slider, stage name, draw calls, pivot/axis helpers |
| `?s=<-1..1>` | freeze the sequence at a position (`-1…0` entry from the hero, `0…1` progress) |
| `?layout=landscape\|portrait` | force an exploded-offset/camera table |
| `?static=1` | force the static fallback (poster, no WebGL) |

## Files

| File | Role |
| --- | --- |
| `index.html` | hero copy ("Featured in" inside the hero), sequence section, Portfolio stub |
| `machine-assembly.css` | overlap into the hero, sticky stage, entry shade, glow, static mode |
| `machine-assembly.js` | lazy loading, scroll driver, timeline evaluation, camera fit, lighting, fallbacks |
| `timeline.js` | per-group windows, exploded offsets, waypoints, rotations, screw turns; camera and light keys |
| `assets/tattoo-machine.glb` | 18-group GLB, `KHR_mesh_quantization`, 2K JPEG textures (analysis copy source) |
| `assets/machine-pivots.json` | pivot, axis and bounds per group |
| `assets/poster-*.webp` | posters rendered from this scene (fallback and pre-load state) |
| `lib/GLTFLoader.js`, `lib/RoomEnvironment.js` | byte-identical copies of `three@0.128.0/examples/js/` |

Library copies (SHA-256, identical to `node_modules/three/examples/js/`):

- `lib/GLTFLoader.js` `5c15967ba830918a9caea6338712c994c354bccd4edc4569bde411c3ec06a3e6`
- `lib/RoomEnvironment.js` `94fd17363598048cb3faf3b3d7d663e561e8bc929b0162716f33424af30695ad`

## Rebuild the model

Raw purchased sources are kept outside git (`source-assets/` is ignored because
Cloudflare Pages publishes the repository root):

```bash
node scripts/machine-model/build-machine-glb.mjs \
  --source source-assets/tattoo-machine/GLB_tattoo_inker_analysis_2K.glb \
  --out prototypes/machine-assembly/assets/tattoo-machine.glb \
  --pivots prototypes/machine-assembly/assets/machine-pivots.json --check
```

## Check assembly paths

```bash
node scripts/machine-model/check-assembly-paths.mjs --steps 120 \
  --json specs/homepage-machine-assembly/evidence/assembly-paths.json
```
