# Public deploy boundary (Cloudflare Pages)

## Why

Cloudflare Pages publishes its build output directory as-is. Pages has no
ignore file; it only skips `.git`, `node_modules` and `.DS_Store`. Until this
change the site had no build command and the output directory was the
repository root, so every tracked file was public. Observed on production on
2026-09-26 (read-only requests): 221 of 238 tracked non-site paths returned 200,
including `/AGENTS.md`, `/package.json`, `/.mcp.json`, `/.env.example`,
`/.github/workflows/*.yml`, `/workers/*.js`, `/scripts/*.mjs`, `/docs/audits/*.md`,
`/.agents/…`, `/geo_agent/…` and `/tests/*.py`. Only `/.git/*`, `/_headers` and
`/_redirects` were not served.

A secret-pattern scan of tracked files (private keys, AWS/OpenAI/GitHub/Slack
tokens, JWTs, `service_role`) found no credentials. The exposure is internal
information. Treat content that was published as disclosed.

## How it works

`scripts/build-public.mjs` copies an explicit allowlist into `dist/`, and Pages
publishes `dist/`:

- `PUBLIC_PAGES`: every published HTML page, listed by repository path.
- `PUBLIC_ROOT_FILES`: root files (`components.js`, `robots.txt`, `sitemap.xml`,
  `llms.txt`, favicons) and the Pages configuration files `_headers` and
  `_redirects` (parsed by Pages, never served).
- `PUBLIC_ASSET_DIRS`: asset directories published recursively, limited to web
  file types (images, video, fonts, CSS, JS) plus vendored `LICENSE` texts.
  Build-time files inside them (`README.md`, `metadata.json`, `Info`, `.keep`)
  are not published.

Rules:

- A file that is not allowlisted is not published. A new page, root file or
  asset directory stays private until it is added to the lists.
- The allowlist does not read `sitemap.xml`. The sitemap is an SEO statement; the
  deploy boundary is a security control. A `noindex` page can be published by
  adding it to `PUBLIC_PAGES`.
- `prototypes/`, `specs/`, `docs/`, `scripts/`, `workers/`, `tests/`,
  `geo_agent/`, `source-assets/`, dotfiles, Markdown, `package*.json`,
  `metadata.json` and similar paths are forbidden in the output. The build fails
  if the allowlist ever includes one. This applies to production and preview.
- The build fails if an allowlisted file is missing or if any root-relative
  reference in published HTML/CSS/JS/text does not resolve inside `dist/`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build:public` | write `dist/` (what Pages runs) |
| `npm run build:public:check` | build into a temp dir, verify, discard (CI) |
| `npm run build:public:self-test` | exercise every rule on a synthetic tree (CI) |
| `npm run verify:deploy -- <url>` | check a deployed preview or production URL |

`verify:deploy` requests, read-only: every page and root file, every CSS/JS/font
and one file per asset directory (expects 200); security headers from
`_headers`; every `_redirects` rule; and every git-tracked file outside the
public set plus internal directories and an unknown path (expects 404).

## Cloudflare Pages settings

Workers & Pages → the site project → Settings → Build:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `node scripts/build-public.mjs` |
| Build output directory | `dist` |
| Root directory | empty (repository root) |
| Environment variable (Production and Preview) | `SKIP_DEPENDENCY_INSTALL` = `1` |

The script uses Node built-ins only, so dependency installation is skipped.

## Adding a public file

1. Add the page to `PUBLIC_PAGES`, the root file to `PUBLIC_ROOT_FILES`, or the
   new asset directory to `PUBLIC_ASSET_DIRS` in `scripts/build-public.mjs`.
2. `npm run build:public:check`.
3. After deployment, `npm run verify:deploy -- https://vishartattoo.com`.
