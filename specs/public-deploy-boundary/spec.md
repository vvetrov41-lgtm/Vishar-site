# Feature Specification: Public deploy boundary

## Status

- Feature: `public-deploy-boundary`
- State: In review (code complete; Cloudflare Pages dashboard change pending, owner-applied)
- Owner/workstream: Claude Code session, branch `claude/public-deploy-boundary`
- Related: `docs/public-deploy-boundary.md`; blocks Phase 3 of `specs/homepage-machine-assembly/`

## Problem

Cloudflare Pages publishes the repository root, so internal files are public on
vishartattoo.com: agent instructions, audits, CI workflows, Worker sources,
package manifests, dotfiles (221 of 238 tracked non-site paths returned 200 on
2026-09-26).

## Goals

- Production and preview publish only intended public files.
- A new file is private by default.
- The boundary is independent of `sitemap.xml`.

## Non-goals

- Changing page content, `_headers` rules, CSP, redirects or caching.
- Migrating from Pages to Workers static assets.
- Rotating credentials (none were found by the secret-pattern scan).

## Functional requirements

- FR-001: Pages MUST publish only files listed in `scripts/build-public.mjs`
  (`PUBLIC_PAGES`, `PUBLIC_ROOT_FILES`, `PUBLIC_ASSET_DIRS` with web file types).
- FR-002: The allowlist MUST NOT be derived from `sitemap.xml`; `noindex` pages
  MAY be published by listing them.
- FR-003: `prototypes/` and internal paths MUST never be published, in production
  or preview; the build MUST fail if the allowlist includes one.
- FR-004: The build MUST fail on a missing allowlisted file or an unresolved
  root-relative reference in published HTML/CSS/JS/text.
- FR-005: `_headers` and `_redirects` MUST keep working unchanged.

## Security and trust requirements

- SR-001: Deny by default; defence-in-depth forbidden-path patterns.
- SR-002: The build runs with Node built-ins only (no dependency install).
- SR-003: The dashboard change is applied by the owner; no agent mutates the
  Cloudflare project.

## Failure and recovery behavior

- A failing Pages build does not replace the live deployment.
- Rollback: redeploy the previous deployment in Pages, then restore the previous
  build settings.

## Acceptance criteria

- AC-001: `npm run build:public:self-test` and `npm run build:public:check` pass in CI.
- AC-002: A preview deployment built from `dist/` passes
  `npm run verify:deploy -- <preview URL>` (all public URLs 200, headers,
  redirects, every non-public tracked path 404).
- AC-003: After merge and the dashboard change, production passes the same check.

## Open questions

- None.
