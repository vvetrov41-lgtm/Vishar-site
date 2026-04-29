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

- Phase 1A markup/JS serving update completed: affected gallery renderers now emit `<picture>` with AVIF/WebP sources and original JPG/JPEG fallback without changing layout/content. Remaining risk: optimized derivative files must exist in deployed assets for actual byte savings.
