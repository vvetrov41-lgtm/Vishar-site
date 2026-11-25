# Implementation plan

## Observed baseline

- CRM integration trunk: `agent/platform-telegram-self-service`, inspected SHA `be7509bad2d14df20b2f413ec354aa3d0a35b5a5` on 2026-11-25. Public main does not contain the CRM source.
- Production read-only check: migration head `20261123011000_shared_chat_visit_records`. Existing functions `send_healing_question(uuid,uuid,uuid)`, `ask_for_review(uuid,uuid,uuid,text)` and `review_request_reply(uuid)` exist.
- Existing UI: `admin/src/components/HealingReviews.tsx`, `admin/src/lib/review-requests-api.ts`; first stage uses WhatsApp-only RPC; second stage uses WhatsApp-only queue.
- Existing `review_requests` has FKs to `communication_messages` (Meta). Gmail has a separate `email_messages` table, private Gmail thread contexts/excerpts/activity. Do not treat latest email activity as proof of a reply to the healing message.
- Related original implementation: #1318, #1319, #1320. Original spec #1301 remains open; do not overwrite it.

## Approach

1. Fresh-check branch, migration lineage, release jobs and effective send/auth/suppression functions. Inspect current Gmail gateway and delivery/reply ingestion; identify exact thread correlation without exposing provider IDs. Confirm provider restrictions for Instagram.
2. Add a bounded server-side route availability/preview contract for both stages. Resolve artist + client + exact provider account, current send window and approved template using established communication helpers. Rank by actual last activity. Include reason codes, not provider IDs.
3. Add an ordered migration with backwards-compatible review-request email references and channel-aware RPCs. Reuse existing Meta queues and approved email draft/send path with atomic state/outbox mutation, stable operation id and current access/suppression checks. Preserve legacy WhatsApp signatures during staged rollout. Gmail reply detection must require actual thread and inbound timestamp after delivery; handle ambiguous thread correlation fail-closed. If the Gmail gateway lacks the necessary thread evidence, add a narrowly scoped service contract and tests before enabling Email.
4. Update Today UI/API/i18n: channel selector with recommended route, disabled reason, preview, explicit Send, same-channel review default when eligible; keep selection stable on retries and prevent accidental switching during ambiguous send. Separate email and Meta thread navigation. Reconcile GPT/MCP operator parity.
5. Add regression tests: per-artist/role isolation, exact routing, suppression, expired windows, no WhatsApp but email/Instagram, wrong thread, already-decided/replay across channels, failed/uncertain delivery, both workflow stages, legacy compatibility, mobile layout. Update migration lineage checks and function manifest as required.
6. Exact-head CI, safe staged rollout (DB before UI, compatible gateway first where needed), production verification of active revision and read-only route preview on real records. No live client message without a separate explicit send decision. Maintain rollback and compatibility.

## Release boundaries

No schema or provider mutations in this documentation increment. Do not bypass release gates or deploy directly. No client-identifying data or credentials in commits. If exact-head tests or production acceptance are unavailable, report the feature as unfinished.
