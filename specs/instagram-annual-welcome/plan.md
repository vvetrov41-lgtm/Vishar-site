# Implementation and production patch plan

Base: vvetrov41-lgtm/Vishar-site, canonical agent/platform-telegram-self-service
at 4d8086526bae688e83e354d6da4bdb1aeaec48f4; isolated clean worktree.
Production: vfjexhfdbrjmuxfdvbdx; vishar-instagram-production version
ed94a2b4-8157-49ba-ad26-1fa9537fa4fa.

## Architecture

Extend the existing inbound transaction with an AFTER INSERT trigger scoped to
received Instagram contact messages. This avoids a crash between inbound commit
and a second enqueue RPC; webhook deduplication already prevents duplicate inserts.
Use private account controls and a contact registry with UNIQUE identity and row
locks. Reserve, write automation message and existing integration_outbox atomically.
Use one outbox attempt per welcome; registry tracks reserved/sending/sent/unknown
and definitely-unsent outcomes. Keep all attempts in existing messages/outbox.

Extend service_begin_communication_send to revalidate welcome eligibility and pin
the account at the existing pre-POST boundary; existing callers remain compatible.
An outbox update trigger records sent timestamp and 12-month anniversary or unknown
outcome. No uncertain reservation is reclaimed. A separate real-sender Worker patch
maps transport, malformed successful responses and ambiguous 5xx to the existing
communication_send_result_unknown error. WhatsApp adapter remains unchanged.

## Files and tests

- Add ordered migration and pgTAP suite under supabase/.
- Update workers/lib/instagram.js and connector regression tests.
- Add scripts/test-instagram-annual-welcome.mjs and include in test:worker and
  the existing Instagram production validation job.
- Add runbook with exact templates, separate flags and guarded cutover.

## Rollout and rollback

Publish bounded task PR against canonical branch; exact-head CI then merge and
canonical CI. Use existing database-only release then Instagram-code-only release.
No deployment gate bypass, no staging, no provider requests in SQL tests.
Read back migration, ACLs, disabled controls and zero welcome jobs; read back Worker
version, public webhook boundary and unchanged routing/bindings. Rollback switches
off; preserve registry. Old Worker can run against additive disabled schema.

## Analysis

No unresolved blocking spec ambiguity. Historical unknown contacts are intentionally
eligible per the new request. High risk (unknown delivery retry) resolved with a
terminal unknown state, persistent intent and max_attempts=1. Activation and test
contacts remain separate explicit user gates. Exact-head gates may require resolving
concurrent canonical changes before publication.
