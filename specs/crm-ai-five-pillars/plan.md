# Implementation Plan — Vishar CRM AI Five Pillars

## Architectural decision

Build on existing CRM authority boundaries rather than add parallel infrastructure.

- Timeline is a read projection over existing source tables.
- AI client memory and Next Action are derived-state tables.
- Durable AI work uses one bounded CRM-agent job queue for client-state and vision
  orchestration; it does not replace enquiry intake or lifecycle queues.
- Artist alerts use `notifications` and existing Telegram delivery.
- Vision uses the existing model router; Qwen remains the first vision provider.
- External web references use the existing web-research/Firecrawl surface.
- Runtime is fully server-side and iPhone-compatible.

## Phase 1 — Data model and timeline

Add an immutable migration after the current migration head that:

1. Creates `client_ai_state` (one current version per artist/client).
2. Creates `client_ai_next_actions` (append-only recommendations with lifecycle
   status).
3. Creates `enquiry_file_ai_analysis` (structured vision analysis per file/version).
4. Creates `crm_agent_jobs` with pending/processing/succeeded/failed state, leases,
   attempts, dedupe key, and source watermark.
5. Adds RLS and bounded artist/service RPCs.
6. Adds `artist_get_client_timeline(...)` as a union/projection, not a copy.
7. Adds `artist_list_ai_next_actions(...)` for mobile digest.
8. Adds service functions to schedule/claim/release/apply jobs and enqueue an
   idempotent `notifications` row when a material action is created.

The existing generic automation engine is not used as the AI job queue because its
action vocabulary and payload intentionally exclude personal/free-text content. That
security boundary must remain intact.

## Phase 2 — AI contracts

Add schema modules for:
- client brief + next action structured output;
- reference-image structured output.

Add model tasks:
- `crm_client_state`
- `vision_reference_extraction`

Keep provider selection inside the task router.

Client-state prompt rules:
- distinguish authoritative facts from inferred context;
- never invent price, deposit, dates, sessions, booking status;
- return only allowed next-action enum;
- require artist approval for sensitive action types;
- do not persist hidden reasoning.

Vision prompt rules:
- describe only what is visible;
- surface uncertainty and image limitations;
- no medical diagnosis;
- no final cover-up feasibility decision.

## Phase 3 — Server-side orchestration

Add a CRM-agent worker library that:
- claims bounded jobs;
- loads only artist/client scoped facts;
- builds a bounded timeline context;
- runs structured model tasks;
- applies validated state atomically through service RPCs;
- schedules next work idempotently;
- retries safely.

Hook scheduling into:
- successful enquiry intake/update;
- inbound communications registration path where safe and bounded;
- Gmail ingestion/discovery path if a stable source event is available.

If a hook cannot be added safely without changing a production integration contract,
expose a service scheduling RPC and keep the hook deferred rather than coupling to an
unstable path.

## Phase 4 — Telegram mobile control surface

Use existing `notifications` + Telegram delivery. Do not create another Telegram
queue.

Recommendation notifications contain:
- client display name;
- short reason;
- suggested action;
- whether approval is required;
- entity/next-action identifiers needed by the existing deep-link/control surface.

Add bounded digest reads for open actions. If existing Telegram command routing
supports a safe read-only command extension, add "needs me" / open actions there.
Do not add client-send callbacks in this phase.

## Phase 5 — Vision wiring

For private uploaded enquiry files:
- read bytes server-side from private storage;
- enforce existing task MIME/byte/count caps;
- send bytes directly to `vision_reference_extraction`;
- validate and persist the structured analysis;
- include persisted summaries in future enquiry/client-state context.

For external reference URLs:
- keep Firecrawl/web research separate from private-file handling;
- persist only bounded extracted facts when associated to a client/enquiry;
- never expose private storage URLs to Firecrawl.

## Validation

- SQL migration review for ownership, RLS, idempotency, lease races, pagination.
- Unit tests for AI schemas, task routing, prompt safety, and orchestration failure.
- Integration tests for job claim/apply/retry semantics where repository harness
  supports them.
- Existing enquiry AI, communications, Gmail, lifecycle, Telegram, and public-site
  tests must remain unchanged or pass.
- Reconcile GPT operator parity for newly exposed read capabilities.
- Fresh-check branch HEAD before and after implementation.

## Rollout posture

No deployment from this branch. Production enablement is a separate explicit step.
Initial runtime mode should be artist-only/shadow-safe: derive state and notify the
artist, never send to clients automatically.
