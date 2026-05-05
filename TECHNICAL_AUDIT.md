# Technical Website Audit

## 1. Executive Summary

Overall state: the repository is a static multi-page site with shared JS components and a Cloudflare Pages Function endpoint (`/functions/api/gemini.js`). It has strong baseline SEO metadata, canonical tags, sitemap/robots, and a security header file. However, there are high technical risks around frontend performance payload (very large JPG assets + CDN Tailwind runtime), CSP looseness (`'unsafe-inline'`), and deploy reproducibility (no dependency manifest / no build pipeline in repo). 

Main risks:
- Extremely heavy image payloads (many files in 8–17MB range) likely causing poor LCP/INP and mobile instability.
- Render path includes multiple third-party scripts and Tailwind CDN runtime in production pages.
- CSP allows inline scripts/styles globally, reducing XSS resilience.
- No repository-level build/lint/test/typecheck workflow found, limiting reliability checks and deploy confidence.

What to fix first:
1. Reduce image payloads and add modern formats/responsive variants.
2. Tighten CSP and reduce inline script/style usage.
3. Add reproducible build/validation workflow (or explicit static deploy contract) and CI checks.

## 2. Critical Issues

### Issue A
- Severity: High
- Area: Performance
- File(s): `assets/cover-ups/after-04.jpg`, `assets/cover-ups/after-02.jpg`, `assets/cover-ups/after-05.jpg`, `assets/black-grey/05.jpg`, and many other large JPGs.
- Evidence:
  - `assets/cover-ups/after-04.jpg` = 17,804,413 bytes
  - `assets/cover-ups/after-02.jpg` = 15,772,580 bytes
  - `assets/cover-ups/after-05.jpg` = 14,366,223 bytes
  - `assets/black-grey/05.jpg` = 14,245,933 bytes
  (from repository file-size scan command; see section 6)
- Impact: High probability of slow page loads, high mobile data usage, elevated LCP, and potential bounce/conversion loss.
- Recommended fix: Generate responsive image sets + WebP/AVIF derivatives, reduce source dimensions/quality, and serve with `<picture>` and `srcset`.
- Estimated effort: Medium

### Issue B
- Severity: High
- Area: Performance
- File(s): `index.html` and other HTML pages using Tailwind CDN script.
- Evidence: Production pages load `https://cdn.tailwindcss.com` at runtime instead of shipping precompiled CSS (e.g., `index.html` includes `<script src="https://cdn.tailwindcss.com"></script>`).
- Impact: Additional blocking JS and runtime style generation increase startup cost and can degrade Core Web Vitals.
- Recommended fix: Move to precompiled CSS build output; avoid runtime Tailwind CDN in production.
- Estimated effort: Medium

### Issue C
- Severity: High
- Area: Security
- File(s): `_headers`, `index.html` (and other pages with inline scripts/styles).
- Evidence: CSP currently permits `'unsafe-inline'` for both `script-src` and `style-src` in `_headers`, while pages contain many inline `<script>` and `<style>` blocks.
- Impact: Weaker XSS protection posture; CSP does not provide strong mitigation against injected inline payloads.
- Recommended fix: Refactor inline JS/CSS into external hashed/nonce-controlled assets; tighten CSP to remove `'unsafe-inline'` where possible.
- Estimated effort: Medium/Large

### Issue D
- Severity: Medium
- Area: Reliability / DevOps
- File(s): repository root (missing `package.json`), missing `.github/workflows/`, missing `wrangler.toml`.
- Evidence: No package manifest or CI workflow files were found; no explicit deploy config file found in repo.
- Impact: Limited reproducibility and limited automated validation before deploy; increased risk of undetected regressions.
- Recommended fix: Add explicit project/deploy contract and CI checks (even for static site): HTML validation/link checking/image budget checks/security header checks.
- Estimated effort: Medium

## 3. High Priority Improvements

- Add image optimization pipeline and enforce size budgets for gallery/portfolio assets.
- Introduce explicit cache-control strategy by asset type (immutable fingerprinted assets vs HTML) and verify Cloudflare edge caching behavior (requires production URL).
- Add `defer`/loading strategy review for third-party scripts (Three.js/GSAP/ScrollTrigger in homepage animation).
- Validate all canonical/OG/Twitter values across every page for consistency and correctness.
- Add explicit 404 page verification and redirect behavior checks (requires production URL).
- Add structured event tracking plan (book click, form submit, social click) with implementation + naming standard.

## 4. Medium Priority Improvements

- Improve accessibility certainty with automated and manual keyboard/screen-reader checks (requires browser testing).
- Review heading hierarchy depth consistency per page sections.
- Normalize asset naming conventions (e.g., mixed `Info`/`info`, `.jpg.JPG`) to reduce maintenance friction.
- Add `rel="me"` / consistent social identity metadata if brand strategy requires it.

## 5. Quick Wins

- Add explicit `width`/`height` on any remaining content images that might still miss intrinsic dimensions.
- Add preconnect/preload audit for actually-used origins only; remove unused external dependencies.
- Ensure all external links use consistent `rel="noopener noreferrer"` (spot-check shows this is mostly already present).
- Document Cloudflare Pages env vars and bindings required for `/api/gemini` (especially `GEMINI_API_KEY`, optional `RATE_LIMIT`).

## 6. Commands Run

- `pwd; rg --files`
  - Result: repository structure enumerated; static HTML site + assets + `functions/api/gemini.js` found.
- `find . -maxdepth 3 -type f | sed 's#^./##' | head -n 200`
  - Result: confirmed top-level files/folders and absence of obvious build config files in first 200 entries.
- `for f in index.html about/index.html faq/index.html aftercare/index.html ai-tools/index.html black-and-grey-realism-manchester/index.html colour-realism-tattoo-manchester/index.html cover-up-tattoo-manchester/index.html components.js robots.txt sitemap.xml _headers functions/api/gemini.js; do ...; done`
  - Result: reviewed key HTML/JS/SEO/security/function files.
- `test -f package.json && cat package.json || echo 'package.json not found'; test -d .github/workflows && find .github/workflows -maxdepth 2 -type f -print || echo '.github/workflows not found'; test -f wrangler.toml && cat wrangler.toml || echo 'wrangler.toml not found'`
  - Result: `package.json not found`; `.github/workflows not found`; `wrangler.toml not found`.
- `find assets -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.JPG' -o -name '*.png' -o -name '*.webp' -o -name '*.avif' \) -printf '%s %p\n' | sort -nr | head -n 15`
  - Result: many very large image files found (largest ~17.8MB).
- `rg -n "gtag|ga4|googletagmanager|GTM-|fbq|fbevents|tiktok|ttq|plausible|analytics|dataLayer|utm_|consent|cookie|mixpanel|segment" *.html */index.html components.js functions/api/gemini.js`
  - Result: no GA4/Meta/TikTok pixel implementation detected in code; only content links to TikTok found.
- `for f in index.html about/index.html aftercare/index.html faq/index.html ai-tools/index.html black-and-grey-realism-manchester/index.html colour-realism-tattoo-manchester/index.html cover-up-tattoo-manchester/index.html; do echo -n "$f: "; rg -o "<h1\b" "$f" | wc -l; done`
  - Result: one `<h1>` detected per audited page.

## 7. Files Reviewed

- `index.html`
- `about/index.html`
- `aftercare/index.html`
- `faq/index.html`
- `ai-tools/index.html`
- `black-and-grey-realism-manchester/index.html`
- `colour-realism-tattoo-manchester/index.html`
- `cover-up-tattoo-manchester/index.html`
- `components.js`
- `robots.txt`
- `sitemap.xml`
- `_headers`
- `functions/api/gemini.js`
- `assets/` (size/sample inspection)

## 8. Recommended Implementation Plan

### Phase 1: Critical fixes
- Build and apply an image optimization pass (source reduction + AVIF/WebP + responsive variants).
- Replace Tailwind CDN runtime with production CSS build artifact.
- Refactor inline JS/CSS hot spots and tighten CSP policy.

### Phase 2: Performance + SEO
- Add resource loading strategy audit (`defer`, preload/preconnect rationalization).
- Validate metadata consistency at page-level (title, description, canonical, OG/Twitter).
- Verify robots/sitemap in production and search engine visibility signals (requires production URL + Search Console access).

### Phase 3: Tracking + Accessibility
- Implement GA4 (and other required pixels only if needed), event taxonomy, and conversion events.
- Add consent-aware tracking behavior if legally required for target regions.
- Run keyboard + screen-reader + contrast/manual audits in browser environment.

### Phase 4: Cleanup
- Add CI checks for link integrity, HTML issues, security header assertions, and asset budgets.
- Normalize naming conventions and improve repository documentation for deployment + operations.

## 9. Patch Plan

Planned future file changes (not implemented in this audit):
- HTML pages (`index.html`, route `*/index.html`) for image markup, script loading, metadata consistency, and tracking hooks.
- `components.js` for centralized tracking events and accessibility improvements.
- `_headers` for stricter CSP and possibly additional response-header tuning.
- Asset files under `assets/` for optimized formats and responsive variants.
- New optional ops/docs files for reproducible validation workflow (CI/static checks/deploy notes).

Not performed now, per instruction: no production code changes in this audit step.

### Reality-check limitations
- Lighthouse / PageSpeed metrics: not run in this environment.
- Production caching/header behavior and redirect/live 404 behavior: requires production URL.
- GA4/Search Console conversion and indexing outcomes: requires credentials/platform access.
- Full accessibility behavior (tab order, SR output, dynamic behavior): requires manual browser testing.

## 10. Live Production Verification

### Checks performed

Live target: `https://vishartattoo.com` (checked on 2026-04-28 UTC).

1. Attempted direct live HTTP/header verification from this environment with:
   - `curl -sSI https://vishartattoo.com/`
   - `curl -sSI https://www.vishartattoo.com/`
   - `curl -sSI http://vishartattoo.com/`
   - `curl -sSI https://vishartattoo.com/nonexistent-test-page-xyz`
   - `curl -sS https://vishartattoo.com/robots.txt`
   - `curl -sS https://vishartattoo.com/sitemap.xml`
2. Fallback browser/content verification via remote page rendering tool:
   - Opened `https://vishartattoo.com/`
   - Opened `https://vishartattoo.com/ai-tools/`

### Results

- **Production URL availability (partial):** homepage and `/ai-tools/` rendered via remote page tool, confirming the site is publicly reachable through that channel.
- **Direct response-header / redirect / 404 / robots / sitemap checks from shell:** not verifiable in this environment due network/proxy failure (`curl: (56) CONNECT tunnel failed, response 403`).
- **Canonical / OG / Twitter / viewport metadata:** not newly parsed from live HTML in this pass due unavailable local HTTP fetch libraries and blocked `curl` path; baseline repository metadata remains previously documented.
- **Image loading behavior, network payload, console errors, mobile viewport behavior, tracking network events, Cloudflare cache headers:** require real browser DevTools session (or successful HTTP capture) and could not be conclusively measured here.
- **`/api/gemini` live endpoint behavior:** not safely testable from this environment because direct HTTP requests to production failed at network tunnel level.
- **Lighthouse / PageSpeed:** not run in this pass (no working Lighthouse/PageSpeed execution path available in this environment).

### Issues confirmed

- Site appears live and reachable at least for HTML rendering of `/` and `/ai-tools/`.
- Prior repository-based risks (large images, runtime Tailwind CDN, permissive CSP inline allowances, missing repo-level CI/build contract) remain valid and unchallenged by this live pass.

### Issues not reproducible in this pass

- Could not reproduce/validate HTTP status-chain behavior (HTTP→HTTPS, www→apex), response headers, cache headers, or custom 404 behavior due blocked shell network path.
- Could not verify live tracking events/scripts via network panel.

### New issues found

1. **Verification observability gap (High, Reliability/DevOps):** from this execution environment, production HTTP checks are blocked by a CONNECT tunnel 403, preventing standard live validation automation.
   - Impact: live regression/security/performance checks cannot be programmatically confirmed from current runner.
   - Recommendation: run an external monitoring/CI probe from a network that can access production directly, and persist status/header/redirect/Lighthouse baselines.

### What still requires access to Cloudflare / GA4 / Search Console

- **Cloudflare access required:** cache rules/effective edge cache status, WAF/rate-limiting logs for `/api/gemini`, redirect rules, header transforms, bot/security events, and zone-level SSL/TLS settings.
- **GA4 access required:** real event ingestion (e.g., `book_click`, `form_submit`, outbound click events), attribution quality, conversion setup, and duplicate-tag validation.
- **Search Console access required:** index coverage, canonical selection by Google, sitemap processing status, crawl anomalies, and live SEO performance queries.


## 11. Phase 1A Image Optimization Implementation

- Images targeted: top 15 largest JPG/JPEG files under `assets/` (see `IMAGE_OPTIMIZATION_REPORT.md`).
- Original file sizes: collected successfully via filesystem scan.
- Optimized WebP/AVIF generation: **not completed in this execution environment** due blocked dependency installation (`npm` registry 403 and `apt` repository 403).
- Pages identified for update once derivatives exist: `index.html`, `cover-up-tattoo-manchester/index.html`, `black-and-grey-realism-manchester/index.html`, `colour-realism-tattoo-manchester/index.html`.
- Commands run:
  - `find assets -type f \( -iname "*.jpg" -o -iname "*.jpeg" \) -printf "%s %p\n" | sort -nr | head -n 15`
  - `rg -n` lookups for selected filenames across HTML/JS
  - `npm install sharp --save-dev` (failed: 403)
  - `apt-get update && apt-get install -y webp libavif-bin imagemagick` (failed: 403)
- Files changed in this pass:
  - `TECHNICAL_AUDIT.md`
  - `IMAGE_OPTIMIZATION_REPORT.md`
- Images skipped: all 15 targeted files skipped for conversion due missing conversion tooling in this restricted environment.
- Remaining risks: image payload remains a high-severity performance risk until actual AVIF/WebP derivatives are generated and markup switched to `<picture>` with fallbacks.

- Phase 1A status update: optimization execution is blocked in the current Codex environment (dependency/network restrictions), but reproducible tooling has now been prepared (`package.json`, `scripts/optimize-images.mjs`, `.github/workflows/optimize-images.yml`, `IMAGE_OPTIMIZATION_GUIDE.md`) for use in a network-enabled environment.


## 12. Phase 1A markup/JS serving update (2026-04-29)

- Verified optimized sidecar images exist in `assets/` (`.webp`/`.avif` count: 30).
- Updated gallery serving logic to prefer AVIF, then WebP, then original JPG/JPEG/PNG fallback in JS-driven galleries:
  - `cover-up-tattoo-manchester/index.html` now renders gallery images inside `<picture>` with AVIF/WebP `<source>` elements and original fallback `<img>`.
  - `black-and-grey-realism-manchester/index.html` variant resolver now checks `.avif` and `.webp` before legacy extensions.
  - `colour-realism-tattoo-manchester/index.html` variant resolver now checks `.avif` and `.webp` before legacy extensions.
- Updated `index.html` homepage portfolio grid and lightbox image selection to prefer AVIF, then WebP, then JPG fallback for portfolio assets.
- Hero/LCP behavior unchanged: no above-the-fold hero image was switched to lazy-loading in this phase.
- No original JPG/JPEG/PNG files or generated `.webp`/`.avif` files were deleted or modified in this phase.


## 13. Emergency rollback (2026-04-29)

- Rolled back runtime optimized serving to stabilize production image loading.
- Current runtime behavior uses direct JPG/JPEG/PNG paths only across audited gallery pages (`index.html`, `cover-up-tattoo-manchester/index.html`, `black-and-grey-realism-manchester/index.html`, `colour-realism-tattoo-manchester/index.html`).
- No `<picture>` markup, AVIF/WebP `<source>` selection, or async variant probing remains in these gallery render paths.
- Generated sidecar derivatives (`.webp`/`.avif`) remain present in `assets/` for future controlled re-introduction.

- Pilot WebP serving enabled only for homepage portfolio thumbnails 08 and 20. AVIF and lightbox optimization remain disabled pending manual visual testing.

## 14. Tooling update: targeted image optimization inputs (2026-04-30)

- Updated optimization tooling to support scoped runs and format toggles without changing default behavior.
- New optional env controls: `IMAGE_ROOT`, `IMAGE_LIMIT`, `GENERATE_WEBP`, `GENERATE_AVIF`, `FORCE`.
- CI workflow now exposes equivalent `workflow_dispatch` inputs to support repository-side targeted optimization (for example `assets/portfolio`).
- No gallery HTML/JS serving logic changed in this update.



## Update – 2026-04-30

- Homepage WebP pilot was expanded to all 20 homepage portfolio card images (`assets/portfolio/01.jpg` through `20.jpg`) via the existing safe allowlist pattern in `index.html`.
- Homepage lightbox behavior remains unchanged and JPG-only.
- AVIF remains disabled/not used.

## Update – 2026-05-04

- Black-and-grey WebP thumbnail serving enabled only for files with confirmed .webp sidecars. AVIF and lightbox optimization remain disabled.

## Update – 2026-05-05

- Colour-realism WebP thumbnail serving enabled only for files with confirmed .webp sidecars. AVIF and lightbox optimization remain disabled.

- 2026-05-05 follow-up: colour-realism candidate list is now explicit and uses the real third filename `03.jpg.JPG`, keeping gallery/lightbox original-file paths valid.

## 12. Cover-up WebP Serving Update (2026-05-05)

- 2026-05-05: Cover-up WebP serving enabled only for before/after files with confirmed .webp sidecars. AVIF remains disabled. Original JPG/JPEG fallback and before/after behavior remain unchanged.

## Phase 1B Tailwind CDN Replacement Plan

### Current Tailwind usage (audited scope)

Audited files:
- `index.html`
- `about/index.html`
- `faq/index.html`
- `aftercare/index.html`
- `ai-tools/index.html`
- `black-and-grey-realism-manchester/index.html`
- `colour-realism-tattoo-manchester/index.html`
- `cover-up-tattoo-manchester/index.html`
- `components.js` (for dynamic class generation)

Findings:
1. **Tailwind CDN runtime is used in all 8 audited HTML pages** via `<script src="https://cdn.tailwindcss.com"></script>`.
2. **Inline `tailwind.config` exists in all 8 audited HTML pages** directly after the CDN script.
3. **Inline custom theme extension exists** in those config blocks, including:
   - `colors.apple.black = #000000`
   - `colors.apple.darkGray = #1d1d1f`
   - `colors.apple.lightGray = #f5f5f7`
   - `colors.apple.blue = #0071e3`
   - `fontFamily.sans = Inter / system sans stack`
   - `fontFamily.serif = Playfair Display / serif`
4. **Arbitrary-value Tailwind utilities are actively used** (examples):
   - `max-w-[1200px]`, `max-w-[900px]`, `max-w-[1000px]`, `max-w-[1400px]`, `max-h-[90vh]`, `z-[1000]`, `text-[10px]`, `tracking-[0.3em]`, `aspect-[3/4]`.
5. **Dynamic class names exist in JS** and must be included in Tailwind content scanning/safelist strategy:
   - `components.js`: template-literal classes for nav/footer/mobile menu (`${active ? 'text-white' : ''}`, `${active ? 'text-apple-blue' : 'hover:text-white/80'}`), plus static utility strings in generated markup.
   - `index.html`: runtime class assignment patterns like `element.className = '... ' + (condition ? '...' : '...')` and `classList.toggle('rotate-180', ...)`.

### Risks

- **Primary risk: missing utilities after migration** (especially arbitrary values and JS-composed classes) causing spacing/typography/layout regressions.
- **Secondary risk: custom brand tokens loss** if `apple` color/font extensions are not mirrored in `tailwind.config.js`.
- **Purge/content risk:** if content globs omit JS/HTML paths, production CSS may drop classes used only in templates/scripts.
- **Order/specificity risk:** new compiled stylesheet load order vs existing inline `<style>` blocks may cause subtle overrides.

Risk level: **Medium** (safe to proceed if migration is staged and verified page-by-page).

### Exact files that would need changes (implementation PR, not this audit PR)

Minimum expected:
- `index.html`
- `about/index.html`
- `faq/index.html`
- `aftercare/index.html`
- `ai-tools/index.html`
- `black-and-grey-realism-manchester/index.html`
- `colour-realism-tattoo-manchester/index.html`
- `cover-up-tattoo-manchester/index.html`
- `components.js` (only if additional class safelist markers/comments are needed)

New build/config files likely required:
- `package.json` (scripts/devDependencies)
- `tailwind.config.js` (or `tailwind.config.cjs`)
- `postcss.config.js` (if using PostCSS pipeline)
- source stylesheet file (for `@tailwind` directives)
- compiled output CSS file under a stable public asset path

### Proposed build setup (plan only)

Recommended safe approach:
1. Add Tailwind CLI-based build with deterministic output (no runtime CDN).
2. Centralize current inline `tailwind.config` theme extensions into repo config.
3. Set `content` globs to include all audited HTML routes and `components.js`:
   - `./index.html`
   - `./about/index.html`
   - `./faq/index.html`
   - `./aftercare/index.html`
   - `./ai-tools/index.html`
   - `./black-and-grey-realism-manchester/index.html`
   - `./colour-realism-tattoo-manchester/index.html`
   - `./cover-up-tattoo-manchester/index.html`
   - `./components.js`
4. Add targeted safelist for any runtime-only class variants that static scanning cannot reliably infer.
5. Build minified production CSS artifact and link it in each page.

### Proposed CSS output path

- Recommended output: **`/assets/css/tailwind.css`** (or hashed variant such as `/assets/css/tailwind.[hash].css` once cache-busting strategy is finalized).

### Verification checklist (pre-merge for implementation PR)

1. Build succeeds locally with zero Tailwind warnings about invalid utilities.
2. `https://cdn.tailwindcss.com` removed from all 8 audited pages.
3. Inline `tailwind.config` removed from all 8 audited pages.
4. Visual parity check completed for each audited page at mobile/tablet/desktop breakpoints.
5. Confirm no missing styles for arbitrary classes and dynamic JS-generated elements (nav, mobile overlay, sticky CTA, FAQ toggles, lightbox controls).
6. Confirm no CSP/analytics/branding/text changes were introduced.
7. Confirm no unexpected CLS/layout shifts on initial load compared with baseline.
8. Run HTML reference check to ensure compiled CSS path resolves in all routes.

### Rollback plan

If visual/function regressions appear after merge:
1. Revert implementation PR commit(s) in full (single revert preferred).
2. Restore previous CDN script + inline config blocks from git history.
3. Re-run smoke checks on all 8 routes.
4. Re-open migration in a smaller staged PR (e.g., homepage + one inner route first) with screenshots and explicit class safelist diffs.

### Recommendation

- **Recommended implementation approach:** proceed with a dedicated follow-up PR that introduces Tailwind build tooling + compiled CSS, then removes CDN/runtime config only after parity verification.
- **Risk level:** Medium.
- **Safe to proceed in a separate PR:** **Yes**, provided the implementation PR follows the staged verification checklist above and includes a fast rollback path.

## Phase 1B Tailwind CDN Replacement Implementation

- **Files changed:** `package.json`, `package-lock.json` (not updated in this environment), `tailwind.config.js`, `assets/css/input.css`, `assets/css/tailwind.css` (output target), `index.html`, `about/index.html`, `faq/index.html`, `aftercare/index.html`, `ai-tools/index.html`, `black-and-grey-realism-manchester/index.html`, `colour-realism-tattoo-manchester/index.html`, `cover-up-tattoo-manchester/index.html`.
- **Build command:** `npm run build:tailwind` (script uses `tailwindcss -i ./assets/css/input.css -o ./assets/css/tailwind.css --minify`).
- **CDN references removed:** replaced `<script src="https://cdn.tailwindcss.com"></script>` with `<link rel="stylesheet" href="/assets/css/tailwind.css">` on all scoped audited pages.
- **CSS output path:** `/assets/css/tailwind.css`.
- **Safelist strategy:** classes toggled or injected at runtime from `components.js` are safelisted in `tailwind.config.js` (`hidden`, `text-white`, `text-apple-blue`, `hover:text-white/80`, `mobile-overlay-enter`, `lightbox-active`, `hidden-cta`, `reveal`, `visible`, `hero-parallax`, `motion-ready`) to avoid purge removal.
- **Visual verification required in preview:** required before merge to confirm no design drift after static CSS compilation (navigation/menu states, sticky CTA visibility, reveal/parallax states, lightbox/menu overlay states, responsive breakpoints).
- **Rollback plan:** if regressions are detected, revert this phase commit and temporarily restore CDN script + inline `tailwind.config` blocks while refining safelist/content scan coverage, then rebuild and retest.

## Phase 1B Runtime Migration Status Update (Tooling-Only Adjustment)

- The previous Tailwind runtime migration is **blocked** in the Codex environment because a real compiled `assets/css/tailwind.css` could not be generated (npm registry access returned 403), and the committed file was only a placeholder.
- To avoid production styling risk, HTML routes are restored to the current stable Tailwind CDN runtime + inline `tailwind.config` behavior.

### Safer staged plan

1. **Phase 1B-1 (this PR):** add/keep Tailwind build tooling only (no runtime switch in production HTML).
2. **Phase 1B-2:** run a manual GitHub Actions workflow in a network-enabled environment to generate real `assets/css/tailwind.css` and commit generated artifacts (`assets/css/tailwind.css`, `package-lock.json` if produced).
3. **Phase 1B-3:** open a separate PR that replaces CDN runtime includes with compiled CSS links only after visual parity verification.

## 2026-05-05 Update

Phase 1B runtime switch: Tailwind CDN replaced by compiled /assets/css/tailwind.css on scoped pages. Requires Cloudflare preview visual parity check before merge.

## Phase 1C CSP and Security Headers Plan

### Current header state
- Current security headers are set in `_headers` for all routes (`/*`) and include: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `X-Permitted-Cross-Domain-Policies`, and a CSP. 
- Current CSP:
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com`
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
  - `img-src 'self' data: https:`
  - `font-src 'self' https://fonts.gstatic.com`
  - `connect-src 'self' https://generativelanguage.googleapis.com`
  - `object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests`
- Risk summary: CSP currently permits inline script and inline style globally via `'unsafe-inline'`, which materially lowers XSS resistance across all pages.

### Required external origins (observed in repository)
- `https://fonts.googleapis.com` (Google Fonts stylesheet links in all audited pages).
- `https://fonts.gstatic.com` (font file fetches via Google Fonts).
- `https://cdnjs.cloudflare.com` (Three.js/GSAP/ScrollTrigger on homepage and black/grey page).
- `https://generativelanguage.googleapis.com` (AI proxy destination in `functions/api/gemini.js`; also already in CSP `connect-src`).
- `https://cdn.tailwindcss.com` is currently allowlisted in CSP, but no longer required by audited HTML runtime includes in this pass.

### Inline script/style blockers for strict CSP
1. Inline `<script>` blocks are present on every audited HTML page (counts from static scan):
   - `index.html`: 4
   - `about/index.html`: 2
   - `aftercare/index.html`: 3
   - `faq/index.html`: 3
   - `ai-tools/index.html`: 3
   - `black-and-grey-realism-manchester/index.html`: 3
   - `colour-realism-tattoo-manchester/index.html`: 3
   - `cover-up-tattoo-manchester/index.html`: 4
2. Inline `<style>` blocks are present on all audited HTML pages (1 each).
3. Inline event handlers are widespread (`onclick=`):
   - heavy usage in `faq/index.html`, `index.html`, and gallery pages.
4. `components.js` injects inline style and style attributes at runtime:
   - `injectMotionStyles()` appends a `<style>` tag to document head.
   - JS sets element `style.*` directly (e.g., `transitionDelay`, `transform`, `opacity`).
   - HTML templates in `components.js` include `onclick="toggleMenu()"` attributes.
5. Homepage has inline `style="..."` attributes for the 3D machine section and fallback HTML, plus interactive inline handlers in lightbox/FAQ/reviews/aftercare/AI UI.

### Tailwind CSS and `style-src 'unsafe-inline'`
- The repository already ships compiled CSS (`assets/css/tailwind.css`).
- Compiled Tailwind CSS helps remove the need for large inline `<style>` blocks created for styling, but **does not** by itself remove `style-src 'unsafe-inline'` while:
  - page-level inline `style="..."` attributes remain,
  - runtime JS continues to inject `<style>` (`components.js`), and
  - runtime JS writes style properties directly.
- A strict no-inline-style CSP would require refactoring these style attributes and style mutations to class toggles/CSS rules and moving dynamic style logic to nonce/hash strategy or externalized class-based states.

### Existing JS externalization needs before tightening `script-src`
- Before removing `'unsafe-inline'` from `script-src`, these must be moved or reworked:
  1. All page-level inline `<script>` blocks (including `window.PAGE_ID` assignment, JSON-LD blocks, gallery/lightbox logic, FAQ toggles, AI widget logic, homepage 3D logic).
  2. Inline `onclick` handlers in HTML and in HTML strings generated by `components.js`.
  3. Dynamic HTML fragments that embed inline event attributes (e.g., FAQ and mobile nav template strings).
- Practical safe direction: migrate to `addEventListener` in external JS modules and data attributes (`data-action`) instead of inline handlers.

### Safe first-step CSP change (recommended first implementation PR)
- Keep runtime behavior unchanged and make low-risk hardening first:
  1. Remove `https://cdn.tailwindcss.com` from `script-src` if verified absent from all production HTML templates.
  2. Add `worker-src 'self' blob:` only if required by runtime (otherwise omit).
  3. Add `manifest-src 'self'` (safe default).
  4. Add `report-uri` or `report-to` endpoint (Cloudflare/WAF/log collector) for CSP violation telemetry before stricter enforcement.
  5. Preserve `'unsafe-inline'` temporarily for both script/style during this first phase to avoid breakage.
- Example first-step policy direction:
  - `script-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'`
  - `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'`
  - leave other directives as currently defined.

### Final target CSP (post-refactor goal)
- Target once inline scripts/styles and inline handlers are removed/refactored:
  - `default-src 'self'`
  - `script-src 'self' https://cdnjs.cloudflare.com` (or fully self-hosted JS only)
  - `style-src 'self' https://fonts.googleapis.com`
  - `font-src 'self' https://fonts.gstatic.com`
  - `img-src 'self' data: https:` (or narrowed list once all remote image usage is enumerated)
  - `connect-src 'self' https://generativelanguage.googleapis.com`
  - `object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests`
- Optional stronger end-state:
  - replace external CDN libraries with self-hosted pinned assets and remove third-party `script-src` origins entirely;
  - add `require-trusted-types-for 'script'` only after compatibility validation.

### Risks (functional breakage areas)
- **Galleries/lightbox**: inline handlers and inline scripts currently drive image opening/navigation and may fail immediately if inline JS is blocked.
- **Mobile menu + sticky CTA**: `toggleMenu()` and templated nav handlers in `components.js` rely on inline event attributes.
- **Homepage 3D machine section**: contains inline style attributes + inline script logic + external CDN dependencies.
- **FAQ and reviews toggles**: many inline `onclick` entry points.
- **AI tools / Gemini usage**: UI actions rely on inline handlers; `connect-src` must continue to allow Gemini API host for proxy/backend flow.
- **Analytics/tracking**: no GA4/GTM scripts detected in current repository audit; if added later they will require explicit CSP allowances and should use nonce/hash approach.

### Verification checklist (for implementation phases)
1. Run static checks after each CSP increment:
   - enumerate `<script>`/`<style>` inline usage and `onclick=` counts,
   - verify external origin inventory still matches CSP directives.
2. Manual browser smoke checks (requires browser runtime):
   - homepage hero + 3D section,
   - mobile menu open/close,
   - all FAQ toggles,
   - gallery/lightbox open/prev/next/close,
   - AI tools request/response flows.
3. Security header checks (requires production URL):
   - validate final response headers per route,
   - confirm no CSP violations in console/network,
   - confirm no blocked fonts/scripts/styles/images required for UX.
4. Stage rollout:
   - deploy CSP in report-only mode first,
   - collect violation reports,
   - enforce after zero critical violations.

### Rollback plan
- Keep `_headers` changes isolated in dedicated PRs for fast revert.
- If breakage appears post-deploy:
  1. Immediate rollback to prior `_headers` commit (single-file revert).
  2. If partial rollback required, restore `'unsafe-inline'` for affected directive (`script-src` and/or `style-src`) while preserving other hardening directives.
  3. Re-run smoke checklist and inspect CSP violations before next reattempt.
- Operationally: retain a known-good header snapshot in release notes for one-command git revert.

### Phase 1C recommendation status
- Safe first implementation PR is **recommended**, but only as a conservative header cleanup + telemetry step (not strict-inline removal yet).
- First implementation PR should change:
  1. `_headers`: remove unused `cdn.tailwindcss.com` allowlist if confirmed unused in templates.
  2. `_headers`: add CSP reporting endpoint (`report-uri`/`report-to`) and keep current runtime-compatible inline allowances.
  3. `TECHNICAL_AUDIT.md`: document rollout checklist and owners for the next refactor PR that externalizes inline handlers/scripts/styles.


## 15. Phase 1C First Security Headers Hardening (2026-05-05)

### Patch plan (pre-change)
1. Review current `_headers` CSP directives and keep all existing non-CSP security headers intact.
2. Verify scoped HTML pages no longer reference Tailwind CDN runtime (`https://cdn.tailwindcss.com`).
3. Remove only the unused Tailwind CDN origin from `script-src`; keep `'unsafe-inline'` in `script-src` and `style-src` to avoid breaking current inline code paths.
4. Evaluate CSP reporting feasibility; if no existing reporting endpoint exists, do not add `report-uri`/`report-to` and document required endpoint details.
5. Confirm `_headers` syntax remains valid and ensure no unrelated files are modified.

### Files changed
- `_headers`
- `TECHNICAL_AUDIT.md`

### CSP changes made
- Updated `Content-Security-Policy` `script-src` by removing `https://cdn.tailwindcss.com` because Tailwind CDN is no longer referenced in scoped HTML pages.
- Kept `https://cdnjs.cloudflare.com` in `script-src` because it remains in active use.
- Kept `'unsafe-inline'` in both `script-src` and `style-src` intentionally as a temporary compatibility measure for existing inline scripts/styles.
- No new directive families were introduced in this step (no nonce/hash migration in this phase).

### CSP reporting status
- `report-uri` / `report-to` was **not** added in this pass because no existing CSP report collection endpoint is configured in-repo.
- Required for next phase: a real report collector endpoint (for example, Cloudflare-managed endpoint or self-hosted ingestion route) plus retention/alerting decision before enabling reporting directives.

### Security headers preserved
- `X-Content-Type-Options: nosniff` remains present.
- `Referrer-Policy: strict-origin-when-cross-origin` remains present.
- `Permissions-Policy: geolocation=(), microphone=(), camera=()` remains present.
- Framing protection remains present via both `X-Frame-Options: DENY` and `frame-ancestors 'none'`.

### Intentionally not changed
- Did not remove `'unsafe-inline'` from `script-src` or `style-src`.
- Did not refactor inline `<script>` / `<style>` blocks.
- Did not change layout, gallery behavior, images, analytics, Tailwind runtime migration strategy, or site copy/content.
- Did not change any file outside `_headers` and `TECHNICAL_AUDIT.md`.

### Verification performed
- `_headers` syntax check: header block structure remains unchanged and valid line-based `_headers` format is preserved.
- Tailwind CDN reference check: no `https://cdn.tailwindcss.com` references detected in scoped HTML pages.
- Inline compatibility check: `'unsafe-inline'` remains in both `script-src` and `style-src`, so current inline code paths are still allowed.
- Scope check: only `_headers` and `TECHNICAL_AUDIT.md` modified in this phase.

### Verification still needed on Cloudflare preview
- Confirm effective response headers on preview deployment include updated CSP and unchanged companion security headers.
- Confirm no browser console CSP violations on key routes (`/`, gallery pages, `ai-tools`).
- Confirm third-party scripts (Cloudflare CDN-hosted libraries) still execute under updated `script-src`.

### Rollback plan
- If any regression appears, restore previous `Content-Security-Policy` `script-src` value by re-adding `https://cdn.tailwindcss.com` in `_headers` and redeploy.
- Re-run route smoke checks and CSP console checks after rollback.

## Phase 2A CI and Static Validation Plan

### Scope and current repo baseline
- **Task branch:** `phase-2a-ci-static-validation-plan` was created from the available local repository state. Attempting to fetch `origin/main` failed because this checkout has no configured `origin` remote; implementation should be rebased onto the real latest `main` before opening the implementation PR.
- **Package scripts present today:** `optimize:images` runs `node scripts/optimize-images.mjs`; `build:tailwind` runs Tailwind CLI from `assets/css/input.css` to `assets/css/tailwind.css` with minification.
- **Existing GitHub Actions:** `.github/workflows/build-tailwind.yml` is manual-only (`workflow_dispatch`), installs dependencies, builds Tailwind, verifies `assets/css/tailwind.css` is at least 5 KB, uploads the CSS artifact, then commits/pushes generated CSS to `main`. `.github/workflows/optimize-images.yml` is also manual-only and can generate WebP/AVIF derivatives plus optimization reports, then commit/push those generated files to `main`.
- **Tailwind build inputs:** `tailwind.config.js` currently scans the 8 HTML route files plus `components.js`, and safelists classes used dynamically at runtime.
- **HTML routes currently in scope:** `index.html`, `about/index.html`, `aftercare/index.html`, `ai-tools/index.html`, `black-and-grey-realism-manchester/index.html`, `colour-realism-tattoo-manchester/index.html`, `cover-up-tattoo-manchester/index.html`, and `faq/index.html`.
- **Key deployment/SEO files:** `_headers`, `robots.txt`, and `sitemap.xml` are present. `_redirects` is not present in the current checkout, so Phase 2A should only require it if a redirect policy is intentionally introduced later.
- **Current CSS artifact:** `assets/css/tailwind.css` exists and was measured at 20,615 bytes, while `assets/css/input.css` is only the 3 Tailwind directives.
- **Current Tailwind CDN status:** no `cdn.tailwindcss.com` references were found in scoped HTML or `_headers`; matches in `TECHNICAL_AUDIT.md` are historical audit notes only.
- **Current AVIF-in-HTML status:** no `.avif` references were found in HTML pages. AVIF files may exist as generated assets, but the site should not serve AVIF from HTML yet.
- **Current local-link feasibility:** a static parser check over HTML `href`, `src`, and `srcset` values found 0 broken local page/asset references, ignoring external URLs, `mailto:`, `tel:`, fragments, and Cloudflare-managed `/cdn-cgi/` paths.
- **Current image sidecar findings:** all JPG/JPEG/PNG files over 500 KB under `assets/` had WebP sidecars except `assets/gallery/03.jpg`, `assets/gallery/05.jpg`, and `assets/hero/hero.jpg`. Those misses should inform allowlists/budgets rather than surprise-fail CI until the implementation PR defines the intended policy.

### Recommended workflow name
- **Workflow file:** `.github/workflows/static-validation.yml`
- **Workflow display name:** `Static Validation`
- **Trigger:** `pull_request` targeting `main`, plus `workflow_dispatch` for manual reruns.
- **Permissions:** `contents: read` only. This workflow must not commit generated files, push to `main`, optimize images, or alter runtime output.

### Proposed checks
1. **Tailwind CSS build check**
   - Run `npm ci` and `npm run build:tailwind` in CI.
   - After build, run `git diff --exit-code -- assets/css/tailwind.css` so CI fails when committed CSS is stale relative to source HTML, `components.js`, `assets/css/input.css`, `tailwind.config.js`, or dependency lockfile changes.
   - Keep this separate from the existing manual build workflow, because PR validation should report stale artifacts instead of auto-committing them.

2. **No Tailwind CDN references**
   - Search scoped production files for `cdn.tailwindcss.com`.
   - Suggested scope: `*.html`, nested `*.html`, `_headers`, `components.js`, `assets/css/input.css`, and `tailwind.config.js`.
   - Exclude `TECHNICAL_AUDIT.md`, historical reports, and docs so old audit references do not fail runtime validation.

3. **Generated Tailwind CSS artifact exists and is not tiny**
   - Assert `assets/css/tailwind.css` exists.
   - Assert byte size is above a conservative threshold, initially `>= 5000` bytes to match the manual Tailwind workflow.
   - This should run after `npm run build:tailwind`, then again against the committed artifact before diff checking.

4. **Image size budgets**
   - Add a lightweight Node script that scans `assets/` for raster files.
   - Proposed fail budget for new/changed source images: JPG/JPEG/PNG over **2 MB** must have a same-directory `.webp` sidecar unless path is explicitly allowlisted.
   - Proposed warn budget for existing large files: report JPG/JPEG/PNG over **5 MB** and WebP over **1.5 MB** as optimization opportunities, but do not fail immediately because this repo already contains multiple large legacy source images.
   - Keep source originals allowed for now because current HTML still uses JPG fallbacks in `<picture>` patterns.

5. **Broken internal links, if feasible**
   - Add a simple static HTML link checker script using Node built-ins or a small dependency only if necessary.
   - Check local absolute paths like `/about/`, `/assets/css/tailwind.css`, root-relative image paths, and route links that should resolve to files or `index.html`.
   - Ignore external `http(s)` URLs, protocol-relative URLs, `mailto:`, `tel:`, fragments, `javascript:`, generated `/cdn-cgi/` paths, and dynamic JavaScript-generated gallery strings that cannot be resolved safely without executing route scripts.

6. **Key file existence**
   - Fail if `_headers`, `robots.txt`, or `sitemap.xml` are missing.
   - Warn, but do not fail, if `_redirects` is missing unless the project later documents required redirects.
   - Optionally check `sitemap.xml` is well-formed XML and contains the known route URLs.

7. **CSP regression guard for Tailwind CDN**
   - Parse `_headers` and fail if `Content-Security-Policy` contains `cdn.tailwindcss.com`.
   - This specifically protects the previous CSP hardening from accidental reintroduction.

8. **No AVIF served in HTML for now**
   - Fail if scoped HTML files contain `.avif` references in `src`, `srcset`, inline JS templates, or `<source>` tags.
   - Rationale: AVIF derivatives exist from the optimization workflow, but AVIF serving has not been approved as a runtime behavior change yet.

9. **WebP sidecars for allowlisted thumbnails**
   - Create an explicit allowlist of thumbnail/source-image groups that are intentionally served through `<picture>` WebP sidecars today: `assets/portfolio/`, `assets/colour-realism/`, `assets/black-grey/`, and `assets/cover-ups/`.
   - Fail if a JPG/JPEG/PNG in those allowlisted folders lacks the matching `.webp` sidecar.
   - Treat `assets/gallery/` and `assets/hero/` separately until their sidecar/runtime policy is implemented; report missing sidecars as warnings first.

10. **No huge new JPG images without WebP sidecars**
    - On pull requests, compare changed files against the merge base and fail if a newly added JPG/JPEG/PNG under `assets/` is over **500 KB** without a same-directory `.webp` sidecar.
    - For modified existing images, fail only when the file crosses the same threshold and lacks a sidecar; otherwise warn to avoid blocking cleanup PRs that did not introduce the debt.

### Files/workflows to add in the implementation PR
- `.github/workflows/static-validation.yml` — PR/static validation workflow, read-only, no commits.
- `scripts/validate-static-site.mjs` — repository-local validation script for runtime string checks, required files, CSS artifact size, CSP guard, no-AVIF-in-HTML check, sidecar checks, and internal link checks.
- Optional: `scripts/validate-images.mjs` only if image budgets become large enough to keep separate from general static validation.
- `package.json` script additions only; do not change existing `build:tailwind` or `optimize:images` behavior.
- `TECHNICAL_AUDIT.md` implementation notes after the PR is complete.

### Recommended npm scripts
- `"validate:static": "node scripts/validate-static-site.mjs"`
- `"check:tailwind": "npm run build:tailwind && git diff --exit-code -- assets/css/tailwind.css"`
- Optional split if desired for clearer CI logs:
  - `"check:css-artifact": "node scripts/validate-static-site.mjs --css-only"`
  - `"check:images": "node scripts/validate-static-site.mjs --images-only"`
  - `"check:links": "node scripts/validate-static-site.mjs --links-only"`

### What should fail CI
- `npm ci` fails.
- `npm run build:tailwind` fails.
- `assets/css/tailwind.css` is missing after build.
- `assets/css/tailwind.css` is below the chosen minimum byte threshold, initially 5 KB.
- Tailwind build changes `assets/css/tailwind.css` and the generated artifact was not committed.
- Runtime-scoped HTML, `_headers`, `components.js`, or Tailwind source/config files contain `cdn.tailwindcss.com`.
- `_headers` CSP contains `cdn.tailwindcss.com`.
- Scoped HTML contains `.avif` references.
- Required files `_headers`, `robots.txt`, or `sitemap.xml` are missing.
- A known local route/asset reference in HTML resolves to no file.
- JPG/JPEG/PNG files in allowlisted WebP thumbnail folders lack `.webp` sidecars.
- Newly added huge JPG/JPEG/PNG files under `assets/` lack `.webp` sidecars according to the PR diff policy.

### What should only warn initially
- `_redirects` is absent, because there is no current redirect file or documented redirect requirement.
- Existing legacy JPG/JPEG/PNG files over the proposed size budget when they already predate Phase 2A.
- Existing missing WebP sidecars outside the initial allowlisted folders, specifically `assets/gallery/03.jpg`, `assets/gallery/05.jpg`, and `assets/hero/hero.jpg` until their runtime policy is decided.
- External link checks, because reliable validation requires network access and can be noisy; production crawl remains a separate check requiring production URL.
- Lighthouse/Core Web Vitals checks, because this plan is static validation only and no browser performance run was performed.
- Exact production header behavior, because verifying deployed `_headers` requires a production or preview URL.

### Risks
- **False positives from dynamic HTML strings:** gallery cards are generated by inline JavaScript templates, so link and image-reference parsing must avoid overinterpreting expressions as literal paths.
- **Generated CSS churn:** running Tailwind in CI will rewrite `assets/css/tailwind.css`; the workflow must fail on diff without committing anything.
- **Legacy image debt:** the repo contains many large existing source images, so CI should distinguish new PR debt from existing debt to avoid blocking unrelated changes.
- **Docs/history noise:** `TECHNICAL_AUDIT.md` intentionally contains historical `cdn.tailwindcss.com` references; validation must scope checks to runtime files rather than all Markdown.
- **Manual workflow overlap:** existing manual workflows commit generated CSS/images to `main`; the new PR workflow must be read-only to prevent competing writes.
- **No production verification:** static validation cannot prove Cloudflare Pages serves `_headers`, redirects, or caching exactly as expected without a preview/production URL.

### Rollback plan
- Keep the implementation PR limited to `.github/workflows/static-validation.yml`, validation script(s), `package.json`, `package-lock.json` only if script/dependency changes require it, and `TECHNICAL_AUDIT.md` notes.
- If CI blocks legitimate PRs, temporarily disable only the new `Static Validation` workflow or change the failing rule from fail to warn in `scripts/validate-static-site.mjs`.
- If Tailwind artifact checks are noisy, keep `npm run build:tailwind` as a build smoke check and temporarily remove the `git diff --exit-code -- assets/css/tailwind.css` gate while investigating deterministic output.
- If image checks are too strict, reduce enforcement to newly added files only and leave existing assets as warnings.
- Revert the implementation PR to restore the prior repo behavior, because Phase 2A should not alter runtime website files or production behavior.

### Estimated risk and implementation recommendation
- **Estimated risk:** Low, provided the implementation PR is read-only, scoped to validation/CI files, and distinguishes legacy warnings from new failures.
- **Safe to implement in a separate PR:** Yes. The plan is safe for a dedicated follow-up PR because it does not require runtime HTML/CSS/image behavior changes and can be rolled back by reverting the validation workflow/scripts.

## Phase 2A Static Validation CI Implementation

### Files changed
- `package.json` adds the `validate:site` npm script that runs the repository-local validator with Node.
- `scripts/validate-site.mjs` adds read-only static validation for compiled CSS, runtime HTML string regressions, required deployment/SEO files, local static references, WebP sidecar allowlists, and large legacy image warnings.
- `.github/workflows/static-validation.yml` adds the read-only GitHub Actions workflow for pull requests to `main` and manual dispatch.
- `TECHNICAL_AUDIT.md` documents this Phase 2A implementation, operational scope, fail conditions, warning-only checks, workflow trigger, and rollback plan.

### Checks implemented
- Confirms `assets/css/tailwind.css` exists and is larger than 10 KB.
- Confirms scoped HTML files do not reference `cdn.tailwindcss.com`.
- Confirms scoped HTML files do not contain `tailwind.config =`.
- Confirms scoped HTML files do not reference `.avif`.
- Confirms required key files exist: `robots.txt`, `sitemap.xml`, and `_headers`.
- Confirms `_headers` `Content-Security-Policy` does not contain `cdn.tailwindcss.com`.
- Parses literal local `href`, `src`, and `srcset` references from HTML and verifies they resolve to local files or local `index.html` pages.
- Checks explicit WebP sidecar allowlists for homepage portfolio thumbnails, black-grey thumbnails, colour-realism thumbnails, and cover-up before/after images.
- Scans JPG/JPEG/PNG files under `assets/` and warns when files larger than 2 MB do not have matching WebP sidecars.

### Fail conditions
- `assets/css/tailwind.css` is missing or is 10 KB or smaller.
- Any scoped HTML file references `cdn.tailwindcss.com`.
- Any scoped HTML file contains `tailwind.config =`.
- Any scoped HTML file references `.avif`.
- `robots.txt`, `sitemap.xml`, or `_headers` is missing.
- `_headers` CSP contains `cdn.tailwindcss.com`.
- A literal local HTML `href`, `src`, or `srcset` reference cannot be resolved to an existing local asset or page.
- An explicitly allowlisted source image or its mapped `.webp` sidecar is missing.
- The CI dependency install, Tailwind build, or validation command fails.

### Warning-only checks
- JPG/JPEG/PNG files larger than 2 MB without WebP sidecars are reported as warnings only for Phase 2A so existing image debt does not block unrelated pull requests.
- The validator does not check external URLs, deployed Cloudflare header behavior, production analytics, Search Console, Lighthouse, or live Core Web Vitals; those remain separate checks requiring a production or preview URL where applicable.

### Workflow trigger
- `.github/workflows/static-validation.yml` runs on pull requests targeting `main` and on manual `workflow_dispatch`.
- The workflow uses `permissions: contents: read`, checks out the repository, sets up Node 20, runs `npm install`, runs `npm run build:tailwind`, and then runs `npm run validate:site`.
- The workflow is read-only and does not commit, push, upload generated runtime changes, or auto-modify repository files.

### Rollback plan
- Revert the Phase 2A implementation commit to remove the new npm script, validator, workflow, and documentation note.
- If a valid pull request is blocked by a false positive, temporarily disable `.github/workflows/static-validation.yml` or change the specific rule in `scripts/validate-site.mjs` from failure to warning while investigating.
- If Tailwind output proves non-deterministic in CI, keep the validator available locally and temporarily remove or isolate the workflow Tailwind build step until deterministic output is restored.
- Because no runtime website files, HTML content, gallery logic, images, Tailwind runtime behavior, CSP behavior, or Cloudflare Functions are changed by this implementation, rollback is limited to CI/validation files and documentation.
