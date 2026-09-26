# Technical audits — index

This file is the entry point. Read the scope note before using any finding.

| Document | Scope | Status |
|---|---|---|
| [docs/audits/2026-09-22-vishar-crm-remediation.md](docs/audits/2026-09-22-vishar-crm-remediation.md) | **Vishar CRM** (trunk `agent/platform-telegram-self-service`, Supabase, Cloudflare Workers, GPT Actions): audit of 2026-09-22 and its remediation | active remediation record |
| [docs/audits/website-performance-history.md](docs/audits/website-performance-history.md) | **Public website** (`main`): historical PageSpeed, hero/LCP, Tailwind, CSP and CI work from April–May 2026 | historical, not CRM scope |
| [docs/github-rulesets/](docs/github-rulesets/) | Importable GitHub rulesets for `main` and the CRM trunk | ready to import |
| [docs/public-deploy-boundary.md](docs/public-deploy-boundary.md) | **Public website** deployment: Cloudflare Pages published the whole repository root; allowlist build into `dist/` (2026-09-26) | fix in review; dashboard change pending |

## Scope rules

- CRM remediation scope is **only** the 2026-09-22 CRM document. Website history entries are not CRM findings.
- New website technical audits are appended below this index (the `website-technical-audit` skill writes here).
- New CRM audits get their own dated file under `docs/audits/`.
