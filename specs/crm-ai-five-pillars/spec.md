# Vishar CRM AI Five Pillars

## Status

Implementation branch: `agent/crm-ai-five-pillars`

This feature is intentionally isolated from production. Deployment, secret changes,
and production migrations are out of scope until explicitly authorized.

## Problem

Vishar CRM already has durable communications, enquiry intake, lifecycle automation,
internal notifications, Telegram delivery, and an AI task router. What is missing is
the AI state layer that turns those existing facts into a compact client memory and
a safe suggested next action, plus a wiring path for reference-image understanding.

The artist operates from an iPhone only. No part of the runtime may depend on a
desktop computer, a persistent local Codex session, or a workstation being online.

## Goals

1. Present one bounded client timeline without creating a second message store.
2. Persist a compact, versioned, provenance-aware AI client brief derived from CRM
   facts and communications.
3. Persist a constrained AI Next Action recommendation that never becomes an
   autonomous booking, payment, pricing, or client-send authority.
4. Deliver actionable recommendations through the existing durable `notifications`
   / Telegram path and expose a bounded digest/read surface.
5. Analyze uploaded reference images through the existing Qwen-first vision route,
   persist structured summaries, and make those summaries available to intake and
   client-state reasoning. External web references remain a Firecrawl/web-research
   concern and must not be used to fetch private CRM storage objects.

## Non-goals

- Replacing `conversations`, `messages`, Gmail storage, activity history, or lifecycle
  automation with another event store.
- Autonomous client communication.
- Autonomous price, deposit, session-count, availability, or booking decisions.
- Persisting hidden chain-of-thought.
- Medical diagnosis, skin diagnosis, or autonomous cover-up feasibility decisions.
- Adding a desktop runtime dependency.
- Deploying this branch.

## Existing authoritative systems

- `conversations` and `messages` are the canonical durable communication store for
  supported communication transports.
- `gmail_messages` is an existing Gmail-specific store with bounded artist reads.
- `enquiries`, `projects`, `sessions`, payments/deposits, and lifecycle state remain
  authoritative for their domains.
- `notifications` is the durable per-profile artist notification source; existing
  Telegram delivery leases from it.
- Existing Telegram self-service/delivery infrastructure is the artist control
  surface.
- Existing AI task routing determines model/provider choice. Callers request a task,
  never a provider.
- Private enquiry files remain private and are read server-side only for bounded
  analysis.

## Functional requirements

### FR-1 Unified client timeline projection

The CRM shall expose an artist-authorized, bounded timeline read for one client.
The projection shall reuse authoritative source tables rather than copying their
payloads into a second timeline table.

At minimum it shall merge:
- communications messages from `messages`;
- Gmail messages from `gmail_messages`;
- enquiry-level CRM events where a reliable timestamp and client ownership exist.

Every timeline item shall identify its source type, direction when applicable,
timestamp, stable source id, and bounded display text. Pagination must be stable.

### FR-2 Persistent AI client brief

The CRM shall persist one current AI brief per artist/client and maintain a monotonic
version. The row shall include:
- compact human-readable summary;
- structured `brief` JSON;
- `missing_information`;
- source watermark;
- provider/model metadata;
- refresh timestamp.

The brief is derived state only. It must not overwrite authoritative CRM facts.

Structured brief output may record pricing/deposit/date facts only when they are
present in authoritative input/provenance. It may not invent or approve them.

### FR-3 AI Next Action

The CRM shall persist constrained Next Action recommendations. Allowed action types
are a fixed whitelist such as:
- `request_information`
- `artist_review`
- `prepare_quote`
- `offer_dates`
- `request_deposit`
- `confirm_booking`
- `follow_up`
- `await_client`
- `no_action`

Each recommendation shall contain a reason, priority, missing information, optional
draft text, provenance/watermark, and approval requirement.

Actions involving quote/price, dates, deposits, bookings, client sends, or tattoo
feasibility require explicit artist approval. The AI path shall have no generic tool
execution surface and no direct mutation of authoritative booking/payment state.

### FR-4 Telegram dispatcher and digest

When a materially new actionable recommendation is persisted, the system shall
enqueue a durable `notifications` row through the existing notification system.
It must be idempotent per recommendation.

Telegram delivery shall be a presentation of CRM state, not the source of truth.
A failed Telegram delivery shall not roll back CRM state.

The CRM shall expose a bounded artist-authorized read for open recommendations so
the mobile control surface can provide a digest such as "needs me" / "today".

### FR-5 Reference-image understanding

The CRM shall support structured analysis of bounded enquiry reference images using
the existing vision task router, Qwen first with existing fallback policy.

Only supported image MIME types and size/count limits defined by the AI task layer
may be sent to a model.

Persisted output shall be descriptive, for example:
- image/reference type;
- visible existing tattoo;
- visible body area when reasonably apparent;
- reference subjects;
- style/composition features;
- cover-up relevance cues;
- image-quality limitations;
- compact vision summary.

The model shall not make a final cover-up feasibility decision or medical judgment.

The main enquiry/client-state AI may rely on persisted vision summaries, but must
not claim it directly inspected an image unless that analysis record exists.

External URLs may be researched through the existing web-research/Firecrawl path;
private storage URLs must never be sent to Firecrawl.

## Safety invariants

1. Authentication and artist/client ownership checks precede reads and writes.
2. Service-role mutation functions validate artist/client/enquiry/file relationships.
3. AI output is schema-validated before persistence.
4. Hidden reasoning is never stored; only bounded structured results are stored.
5. AI unavailability is fail-safe: CRM facts remain usable and no client-facing
   action is performed.
6. Recommendation creation is idempotent for a source watermark.
7. Financial, availability, booking, tattoo-feasibility, and client-send authority
   remains with the artist or existing deterministic business rules.
8. No feature depends on a desktop process being online.

## Acceptance scenarios

### New enquiry with text only
A booking-form enquiry is stored, intake runs, the client brief is refreshed, a
Next Action is suggested, and—if actionable—the artist gets one Telegram
notification. No client message is sent automatically.

### New enquiry with reference images
The private files remain private; bounded supported images are analyzed server-side.
Structured summaries are persisted and included in subsequent state reasoning.
Unsupported/oversized files are skipped safely and surfaced as limitations.

### Client replies by WhatsApp
The existing communication store receives the inbound message. The client-state job
is scheduled from the new source watermark. The brief and Next Action update without
creating a duplicate timeline copy.

### Client replies by Gmail
The existing Gmail record remains authoritative. The timeline projection can show
the Gmail item alongside communications items, and the same client-state refresh can
consume it.

### Quote/date/deposit-related recommendation
The AI may recommend `prepare_quote`, `offer_dates`, or `request_deposit`, but the
record is marked approval-required and no authoritative booking/payment mutation is
performed.

### AI provider failure
The durable job retries within bounded policy and ultimately records failure without
blocking enquiry persistence or communication ingestion.

## Rollout

1. Schema + read projection + derived-state tables/RPCs.
2. AI schemas/tasks and server-side orchestration in shadow mode.
3. Telegram internal notifications for artist-only recommendations.
4. Vision analysis of private uploaded references.
5. Tests and operator parity reconciliation.
6. Separate production rollout only after explicit authorization.
