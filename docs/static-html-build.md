# Static HTML build

The site ships as plain static files. Nav, footer, the portfolio and gallery
grids, and the portfolio cross-links used to be assembled in the browser by
`components.js` and per-page inline scripts, which left the raw HTML response
empty for any crawler that does not execute JavaScript. That markup is now
generated at build time and committed, and the browser scripts only attach
behaviour to it.

## Source of truth

| File | Owns |
| --- | --- |
| `scripts/lib/site-content.mjs` | nav links, collection links, socials, nav markup, footer markup, portfolio cross-links, homepage collection cards, homepage approach block |
| `scripts/lib/site-galleries.mjs` | homepage portfolio grid, homepage studio gallery, colour realism grid, black & grey grid, cover-up before/after pairs, and the metadata-driven portrait / large-scale / fresh-vs-healed galleries |
| `assets/<gallery>/metadata.json` | alt text, captions and ordering for the portrait, large-scale and healed galleries |

Nothing else defines that markup. `components.js` no longer holds link data.

## Generating

```bash
npm run build:html          # write the generated blocks into the HTML files
npm run build:html:check    # fail if any committed file is out of date
```

The generator replaces whatever sits between a matched pair of marker comments
and leaves the rest of the file alone:

```html
<div id="site-nav">
  <!-- build:nav -->
  … generated …
  <!-- /build:nav -->
</div>
```

Markers in use: `nav`, `footer`, `gallery`, `crosslinks`, `portfolio-grid`,
`studio-grid`, `portfolio-collections`, `homepage-approach`. Edit the source
modules, never the generated blocks — the next build overwrites them.

## Committed output

The generated HTML is committed, the same way `assets/css/tailwind.css` is.
Cloudflare Pages therefore keeps serving the repository as-is, with no build
step of its own. `npm run validate:site` re-runs the generator in check mode and
fails on drift, and it also asserts on the raw file contents that every page
carries the main nav, the footer, the shared internal links, and every gallery
image with alt text.

## After changing markup

1. `npm run build:html`
2. `npm run build:tailwind` if you introduced a Tailwind class that no page used before
3. `npm run validate:site`
4. Commit the regenerated HTML alongside the source change
