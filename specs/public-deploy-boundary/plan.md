# Implementation Plan: Public deploy boundary

- Spec: `specs/public-deploy-boundary/spec.md`
- Target branch: `claude/public-deploy-boundary` from `origin/main` `4dd40fe`

## Current-state evidence

- `docs/static-html-build.md`: Pages serves the repository with no build step.
- Cloudflare docs: Pages skips only `.git`, `node_modules`, `.DS_Store`; no ignore file
  (`.assetsignore` is Workers-only).
- Production (2026-09-26, `verify-public-deploy.mjs`): 70/70 public URLs 200, 9/9
  redirects, security headers present; 221/238 private paths 200.

## Design

- `scripts/build-public.mjs`: explicit allowlist → `dist/`; forbidden patterns;
  missing-file and reference checks; `--check`, `--self-test`.
- `scripts/verify-public-deploy.mjs`: read-only verification of a deployed URL.
- CI (`static-validation.yml`): self-test and build check on every PR.
- Pages settings (owner): build command `node scripts/build-public.mjs`, output
  `dist`, `SKIP_DEPENDENCY_INSTALL=1` for Production and Preview.

Alternatives rejected: Pages Functions + `_routes.json` (runtime code in a static
site, `_headers` not applied to Function responses, fail-open quota risk);
Workers static assets with `.assetsignore` (migration, not a minimal fix).

## Rollout

1. Merge is safe before the dashboard change (Pages ignores the script until the
   build command is set).
2. Owner records current build settings, applies the new ones; the next preview
   build of this branch (or a retry) publishes `dist/`.
3. `npm run verify:deploy -- <preview URL>` must pass.
4. Merge; production build publishes `dist/`; verify production.

If the settings change before merge, production builds of `main` fail (script
missing) and Pages keeps the current live deployment.

## Rollback

Pages → Deployments → previous production deployment → Rollback; then restore the
recorded build settings (empty build command, previous output directory).
