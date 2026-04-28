---
name: website-technical-audit
description: Technical website audit skill for frontend quality, performance, technical SEO, security, deployment, analytics, accessibility, and reliability. Use when asked to audit a website repository before making code changes.
---

# Website Technical Audit Skill

## Purpose

Use this skill to audit a website repository technically before changing production code.

The audit must focus on:

- frontend implementation quality
- performance
- Core Web Vitals readiness
- technical SEO
- security
- deployment configuration
- Cloudflare/GitHub setup
- analytics and conversion tracking
- accessibility
- reliability
- maintainability

The expected output is:

TECHNICAL_AUDIT.md

Do not modify production website code unless the user explicitly asks for implementation after reviewing the audit.

## Role folders used by this skill

Use the logic of these specialist roles:

- Frontend Developer: engineering/engineering-frontend-developer.md
- Code Reviewer: engineering/engineering-code-reviewer.md
- DevOps Automator: engineering/engineering-devops-automator.md
- Security Engineer: engineering/engineering-security-engineer.md
- SRE: engineering/engineering-sre.md
- SEO Specialist: marketing/marketing-seo-specialist.md
- Tracking & Measurement Specialist: paid-media/paid-media-tracking-specialist.md
- Performance Benchmarker: testing/testing-performance-benchmarker.md
- Accessibility Auditor: testing/testing-accessibility-auditor.md
- Reality Checker: testing/testing-reality-checker.md

If the project includes API endpoints, Cloudflare Workers, booking endpoints, contact forms, Telegram integrations, or other backend logic, also apply:

- API Tester: testing/testing-api-tester.md
- Backend Architect: engineering/engineering-backend-architect.md

These folder paths are role references. If the files are not present in the repository, still apply the role responsibilities described below.

## Audit process

### 1. Repository scan

Identify:

- framework or stack
- package manager
- build tools
- deploy configuration
- public assets
- page structure
- components
- routing
- forms
- scripts
- analytics/tracking code
- Cloudflare configuration if present
- GitHub Actions if present

Review these files if they exist:

- package.json
- package-lock.json
- pnpm-lock.yaml
- yarn.lock
- vite.config.*
- next.config.*
- astro.config.*
- tailwind.config.*
- tsconfig.json
- public/
- src/
- app/
- pages/
- components/
- .github/workflows/
- wrangler.toml
- _headers
- _redirects
- robots.txt
- sitemap.xml

### 2. Safe commands

Run safe available commands if they exist:

- install dependencies only if needed
- build
- lint
- test
- typecheck
- format check
- static analysis

Do not add new dependencies without explicit need.
Do not run destructive commands.
Do not deploy.

Record every command and result in TECHNICAL_AUDIT.md.

### 3. Frontend audit

Check:

- valid HTML structure
- semantic elements
- one h1 per page where appropriate
- correct heading hierarchy
- mobile-first layout
- responsive behavior
- broken links
- navigation issues
- image lazy loading
- image width and height
- image alt text
- tap target size
- duplicated code
- JavaScript errors visible from code
- hydration/client-side risks if applicable
- unnecessary client-side JavaScript

### 4. Performance audit

Check:

- heavy images
- missing WebP/AVIF
- missing responsive image sizes
- missing width/height on images
- possible layout shift
- render-blocking CSS/JS
- unused CSS/JS risks
- font loading
- missing font-display
- preload/preconnect opportunities
- caching opportunities
- portfolio/gallery performance
- Cloudflare caching/header opportunities if relevant

Do not invent Lighthouse results.
If Lighthouse was not run, say so.

### 5. Technical SEO audit

Check:

- title tags
- meta descriptions
- h1/h2/h3 structure
- canonical URLs
- robots.txt
- sitemap.xml
- Open Graph tags
- Twitter/X card tags
- structured data / JSON-LD
- local SEO relevance
- Manchester / Salford / tattoo / realism / cover up terms where relevant
- indexability
- noindex/nofollow mistakes
- duplicated pages
- 404 page
- redirects
- internal linking
- image alt text

### 6. Security audit

Check:

- HTTPS assumptions
- CSP
- X-Frame-Options or frame-ancestors
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy
- exposed environment variables
- secrets committed to repo
- unsafe inline scripts
- third-party scripts
- form spam risks
- rate limiting if forms/API exist
- CORS if API/Worker exists
- dependency risk if visible from package files

### 7. DevOps and deployment audit

Check:

- build command
- output directory
- Cloudflare Pages configuration
- GitHub Actions workflows
- environment variables
- preview deployments
- redirects
- headers
- custom domain assumptions
- 404 handling
- rollback safety
- deploy reproducibility
- branch assumptions

### 8. Tracking and analytics audit

Check:

- GA4 presence
- Meta Pixel presence if relevant
- TikTok Pixel presence if relevant
- duplicated tracking
- conversion events
- outbound clicks
- form_submit
- instagram_click
- whatsapp_click
- book_click
- UTM support
- cookie/consent issues if relevant
- event naming consistency

Do not invent analytics results.
Only report what is visible in code or configuration.

### 9. Accessibility audit

Check:

- color contrast risks
- keyboard navigation
- focus states
- aria labels
- alt text
- readable font sizes
- reduced motion
- logical tab order
- button/link labels
- form labels
- touch target sizes
- WCAG issues visible from code

### 10. Reality check

Verify:

- what is actually working
- what only appears to be implemented
- what cannot be verified without production URL
- what cannot be verified without credentials
- what requires manual browser testing
- what requires Lighthouse/PageSpeed
- what requires Search Console/GA4 access

## Required output file

Create:

TECHNICAL_AUDIT.md

Use this structure:

# Technical Website Audit

## 1. Executive Summary

Briefly summarize:
- overall state
- main risks
- what should be fixed first

## 2. Critical Issues

Only include issues that can break:
- site functionality
- SEO
- security
- deployment
- conversions
- analytics accuracy

For each issue include:

- Severity: Critical / High / Medium / Low
- Area: Frontend / Performance / SEO / Security / DevOps / Tracking / Accessibility / Reliability
- File(s):
- Evidence:
- Impact:
- Recommended fix:
- Estimated effort: Small / Medium / Large

## 3. High Priority Improvements

Important improvements that should be done soon.

## 4. Medium Priority Improvements

Useful improvements that can wait.

## 5. Quick Wins

Small changes with clear benefit.

## 6. Commands Run

List:
- command
- result
- errors if any

## 7. Files Reviewed

List important files and folders reviewed.

## 8. Recommended Implementation Plan

Use phases:

### Phase 1: Critical fixes
### Phase 2: Performance + SEO
### Phase 3: Tracking + Accessibility
### Phase 4: Cleanup

## 9. Patch Plan

Describe what files should be changed later.

Do not implement the changes yet unless the user explicitly asks.

## Quality rules

- Be specific.
- Reference file paths and line numbers when possible.
- Do not give generic advice without file evidence.
- Do not invent measurements.
- Do not invent production behavior.
- Do not modify production code during audit.
- If something requires a production URL, credentials, browser testing, Lighthouse, GA4, or Search Console, say so clearly.

After creating the files, summarize exactly what was added.
