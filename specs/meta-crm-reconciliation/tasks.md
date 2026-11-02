# Tasks

- [x] Inspect live CRM schema and Meta account identity/timezone.
- [x] Inspect existing Meta Pixel, CAPI, consent and booking idempotency contracts.
- [x] Implement additive private account mapping, validated paid UTM extraction, backfill and view.
- [x] Add timezone, privacy and identity regression tests.
- [ ] Exact-head DB/pgTAP CI green; independent review.
- [ ] Verify the production migration has no conflicts with newer CRM release migrations.
- [ ] Release migration through approved workflow; read back production rows.
- [ ] Build an artist-scoped, bounded CRM read operation and GPT/MCP parity entry if reporting in-app is needed.
- [ ] Confirm actual CAPI acceptance/dedup in Meta diagnostics and distinguish it from CRM reporting.

## Funnel endpoint (stacked on PR #1133)

- [x] `public.service_meta_crm_funnel` backend-only aggregate RPC with suppression (<3 to null), consent and analytics exclusion; pgTAP `361` and the ACL matrix in `050`.
- [x] `GET /internal/meta-funnel` HMAC route with a per-account key, a 300 s window, 404 when off or unauthenticated, and rows rebuilt from contract fields; `scripts/test-meta-funnel.mjs`.
- [ ] Owner: production release of both migrations and the `META_FUNNEL_KEYS` / `CRM_FUNNEL_*` secrets.
