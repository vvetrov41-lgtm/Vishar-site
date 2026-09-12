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

---

## As built

The design above held. This records where the implementation is, and the four
places where building it changed a decision.

### Where things live

| Concern | Implementation |
| --- | --- |
| Switches | `crm_private.crm_agent_config` (`enabled`, `vision_enabled`), plus `CRM_AGENT_ENABLED`, `CRM_AGENT_VISION_ENABLED`, `CRM_AGENT_SHARED_DRAIN_ENABLED`, `CRM_AGENT_TELEGRAM_DIGEST_ENABLED` |
| Scope | `crm_private.client_ai_scope(artist, client)` |
| Freshness | `crm_private.client_ai_watermark(artist, client)` |
| Timeline | `crm_private.client_timeline_items` → `public.get_client_timeline` |
| Brief | `public.client_ai_state` → `public.get_client_ai_state` |
| Next Action | `public.client_ai_next_actions` → `public.list_client_ai_next_actions`, `public.resolve_client_ai_next_action` |
| Images | `public.enquiry_file_ai_analysis` |
| Queue | `public.crm_agent_jobs` + `service_claim_crm_agent_jobs` / `service_complete_*` / `service_fail_crm_agent_job` |
| Rebuild | `public.refresh_client_ai_state(artist, client)` |
| Contracts | `workers/lib/ai/client-state-schema.js`, `workers/lib/ai/reference-image-schema.js` |
| Orchestration | `workers/lib/crm-agent.js`, drained via `/internal/crm-agent/drain` |
| Telegram | `workers/lib/crm-agent-telegram.js`, `service_telegram_client_ai_digest` |

### Four decisions the implementation changed

**The watermark hashes content, not timestamps.** The first version hashed
enquiry `updated_at`. A test caught it: editing an enquiry's idea left the
watermark unchanged, so a brief that no longer matched the CRM reported itself
fresh. Hashing the fields the context projection actually exposes makes
staleness a property of the data rather than of a trigger remembering to bump a
column.

**Claiming takes the newest refresh, not the oldest.** Several events can queue
several refreshes for one client before the drain runs. Claiming oldest-first
guaranteed a stale answer and paid a provider for it. The claim now takes the
newest and marks the backlog it supersedes as stale in the same statement.

**A same-watermark refresh updates its recommendation in place.** The first
version superseded every open recommendation and then inserted with `on conflict
do nothing`, which left the artist with no open next step whenever the watermark
was unchanged. Superseding only *other* watermarks and upserting the current one
keeps exactly one open row, keeps its id stable, and therefore keeps the
notification dedupe key stable.

**`approval_required` is generated, not supplied.** The model was originally
asked to report whether approval was needed. It is now a generated column
derived from `action_type`, so the question is never asked and a model's answer
to it cannot matter.

### What is not here

Deferred items are listed in `tasks.md`. The two worth restating: there is no
Telegram callback/button surface, because every button worth adding is an
action; and no client-facing send, date, deposit or booking can originate from
this system at all. The action vocabulary that could commit one carries no
model-written text, and the approval flag on it cannot be lowered.

---

## Corrective pass

An independent review found three functional gaps. All three shared a shape:
the derived state was correct when it was written and wrong by the time the
artist read it.

**Gmail replies had no content.** The thread hook fired, the timeline carried
the subject line, and the brief learned that something had been said without
learning what. Content now arrives the way the repository already moves Gmail
content into the database: the Gmail Worker, having completed an authorized
read, pushes a bounded excerpt through a service RPC, beside the `source_text`
the enquiry path already sends. Fetching mail at claim time was considered and
rejected — it would put a mailbox credential in a third Worker, which the
scheduler configuration explicitly forbids, to serve a derived-state feature.

The store is capped at five excerpts per artist/client, 4000 characters each,
pruned on insert, in a private schema with no API grant. It is retained rather
than cleared after use because the brief has to stay rebuildable: an excerpt
deleted after one refresh would make the same recomputation produce a different
answer. The enquiry path's keyword relevance gate is untouched — it is the
right question for drafting an enquiry reply and the wrong one for client
memory, where a message on an already-bound thread is relevant by construction.

**Canonical facts did not schedule their own refresh.** The watermark already
covered projects and sessions, so a paid deposit correctly marked a brief
stale; nothing recomputed it. Triggers now fire on the project and session
columns the brief may reason about. Payments need no trigger of their own,
because `payment_requests` already projects onto `projects.deposit_status`;
triggering on the projection means one refresh per material change rather than
one per webhook, and a future payment provider inherits it. A digest of exactly
those columns is both the change test and the event id, so a no-op UPDATE and a
renamed project queue nothing.

**Stale recommendations reached Telegram as current work.** Two paths, failing
at different moments: the pull path could be stale at read time, and the push
path at delivery time, because a notification is queued when a recommendation
is written and delivered by a later cron tick. The digest now withholds stale
rows and queues their replacement keyed on the current watermark, so repeated
reads collapse to one job; and a push is withdrawn when its recommendation
stops being current, unless the connector has already claimed it, in which case
delivery history stands. The shared notification access predicate was
deliberately left alone: it governs every notification type in the CRM.

Two smaller things were fixed while reviewing. The digest first used a
temporary table inside a SECURITY DEFINER function, which puts state in the
caller's temp schema outside the function's fixed search path; it is a CTE now.
And the watermark had grown to measure project and session fields the reader
never showed, so a change could invalidate a brief that the next brief could
not see — those fields are now in `crm_facts` as well.
