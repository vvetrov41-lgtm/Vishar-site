# vishartattoo.com — Updated Build

## What changed

- **Tailwind CDN removed** → built CSS via Tailwind CLI (~15-30KB vs ~300KB runtime)
- **Favicon** added (SVG)
- **Lightbox** — arrows, keyboard (← →), swipe on mobile, image counter
- **Sticky mobile CTA** — fixed "Get a Free Quote" bar on scroll
- **FAQ** — proper `aria-expanded` for accessibility
- **Mobile menu** — animated open/close (opacity transition)
- **AI section** — client-side rate limit (5/min) + server-side KV rate limit (10/min)
- **CTA text** — "Get a Free Quote" + urgency "Currently booking June–July 2026"
- **Social proof** — star rating + review count in hero
- **Alt texts** — unique descriptive alts for every portfolio image
- **Reviews** in nav (desktop + mobile + footer)
- **CSP** updated — Tailwind CDN removed, Cloudflare Analytics ready
- **sitemap.xml** — updated `lastmod`
- **`prefers-reduced-motion`** — animations disabled for users who prefer it
- **Gemini prompt validation** — max 2000 chars, type checks

---

## Setup (one-time)

### 1. Build CSS

```bash
npm install
npm run build:css
```

This creates `style.css` in the root. Commit it with your code.

For live development:
```bash
npm run watch:css
```

### 2. Cloudflare Pages build command (optional)

If you want CSS to build automatically on deploy:

**Dashboard → Pages → your project → Settings → Builds & deployments**

- Build command: `npm run build`
- Build output directory: `/` (root)

### 3. AI rate limiting (recommended)

**Option A — KV (code-based):**

1. Dashboard → Workers & Pages → KV → Create namespace → name it `RATE_LIMIT`
2. Dashboard → Pages → your project → Settings → Bindings
3. Add KV namespace binding: Variable name = `RATE_LIMIT`, select your namespace
4. Deploy — done, the `gemini.js` function will use it automatically

**Option B — Cloudflare WAF rule (no code):**

1. Dashboard → Security → WAF → Rate limiting rules → Create rule
2. URI path equals `/api/gemini`
3. Rate: 10 requests per 60 seconds, per IP
4. Action: Block
5. Save — done

### 4. Cloudflare Web Analytics (free, no cookies)

1. Dashboard → Analytics & Logs → Web Analytics → Add site
2. Copy the token
3. In `index.html`, uncomment the last `<script>` tag and paste your token

### 5. Favicon

The SVG favicon is included. For full browser support, also create:
- `favicon.ico` (48×48) — use https://realfavicongenerator.net
- `apple-touch-icon.png` (180×180)

Place them in the root directory.

---

## File structure

```
├── index.html              ← main page (updated)
├── style.css               ← built by Tailwind CLI (do not edit manually)
├── src/input.css            ← Tailwind source + custom styles
├── tailwind.config.js       ← Tailwind configuration
├── package.json             ← build scripts
├── favicon.svg              ← site icon
├── _headers                 ← security headers (updated CSP)
├── robots.txt
├── sitemap.xml              ← updated lastmod
├── functions/
│   └── api/
│       └── gemini.js        ← AI proxy with rate limiting
└── assets/
    ├── hero/
    ├── portfolio/           ← 01.jpg – 20.jpg
    ├── gallery/             ← 01.jpg – 06.jpg
    └── og/
```

---

## Image optimisation (TODO)

For best performance, convert all JPGs to WebP:

```bash
# macOS (with homebrew)
brew install webp
for f in assets/portfolio/*.jpg; do cwebp -q 80 "$f" -o "${f%.jpg}.webp"; done
for f in assets/gallery/*.jpg; do cwebp -q 80 "$f" -o "${f%.jpg}.webp"; done
cwebp -q 80 assets/hero/hero.jpg -o assets/hero/hero.webp
```

Then update `index.html` to use `<picture>` tags with WebP + JPG fallback.
This is the single biggest speed win after removing Tailwind CDN.
