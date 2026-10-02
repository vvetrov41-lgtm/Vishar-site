# Plan — consultation context

## Layers

| Layer | File | Change |
|---|---|---|
| DB | `supabase/migrations/20261002130000_gpt_consultation_context.sql` | New read-only RPC, grants, comment |
| DB tests | `supabase/tests/1843_gpt_consultation_context.sql` | pgTAP contract |
| GPT Actions routing | `workers/lib/gpt-domain-operations.js` | `getConsultationContext` op (Scheduling, GET) |
| Parity | `docs/gpt-actions/operator-parity.current.mjs` | `sessions.consultation_context` row |
| Unified OpenAPI | `docs/gpt-actions/unified/openapi.scheduling.yaml` | Regenerated |
| MCP | `scripts/build-mcp-plugin-tools.mjs`, `workers/lib/mcp-plugin-server.js` | Tool guidance; `listAppointments` guidance and consultation server instruction point to the new tool |
| MCP parity | `docs/plugin-mcp/operation-parity.json` | Regenerated (206) |
| Node tests | `scripts/test-mcp-plugin-tools.mjs` | New tool assertions |

Legacy `docs/gpt-actions/openapi.production*.yaml`, plugin package 1.0.4 and skills stay unchanged.

## Release order

The GPT Worker rollout refuses while migrations are pending, so the DB goes first.

1. Merge PR into `agent/platform-telegram-self-service` after exact-head CI.
2. Push `release/private-crm-rcNNNN` at the merge SHA. Dispatch `deploy-private-production-database.yml` with `approved_sha=<merge SHA>`, `deploy=true` and `approval_phrase=DEPLOY_PRIVATE_CRM_DATABASE`.
3. Push `release/private-crm-rcNNNN-gpt-worker` as an empty child commit of the merge SHA. This triggers `gpt-production-worker-rollout.yml`.
4. Push `release/private-crm-rcNNNN-inventory-mcp-plugin-activation` at the merge SHA, then a marker child commit. This triggers `mcp-plugin-production-activation.yml`.
5. Readback: production `tools/list` (206 tools; the new definition equals the generated one) and `server/discover`.

## Rollback

- MCP and GPT Worker: redeploy the previous canonical SHA through the same workflows.
- DB: the function is additive. Leaving it in place is harmless. If needed, `drop function public.gpt_get_consultation_context(uuid)` goes in a follow-up migration.
