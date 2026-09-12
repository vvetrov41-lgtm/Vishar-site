# Tasks — Vishar CRM AI Five Pillars

## A. Baseline and specification

- [x] Create isolated branch from fresh `agent/platform-telegram-self-service` HEAD.
- [x] Confirm existing communications core/unified inbox.
- [x] Confirm existing notification/Telegram durable delivery path.
- [x] Confirm current AI intake queue and Qwen vision capability.
- [x] Write spec, plan, and tasks.

## B. Exact-head navigation

- [x] Inspect generic automation engine and decide whether it can be reused for
      CRM-agent jobs without weakening boundaries. It cannot: its payload
      contract excludes personal and free-text data by design.
- [x] Inspect Telegram entity-target delivery support.
- [x] Inspect GPT web-research/Firecrawl contract.
- [x] Inspect current AI router/provider image input contract.
- [x] Inspect enquiry file/private-storage access helpers and current AI orchestration.
- [x] Inspect operator parity manifest and test conventions.

## C. Data layer

Migration `20260910160000_crm_agent_client_ai.sql`.

- [x] Add immutable migration for derived client AI state (`client_ai_state`).
- [x] Add Next Action table with constrained enum/status and approval invariant.
      `approval_required` is a GENERATED column, so model output cannot lower it.
- [x] Add reference-image analysis table (`enquiry_file_ai_analysis`).
- [x] Add durable/idempotent CRM-agent jobs (`crm_agent_jobs`); the generic
      automation queue is not reusable because it intentionally excludes
      personal/free-text payloads.
- [x] Add service scheduling/claim/release/apply RPCs.
- [x] Add artist-authorized unified client timeline projection
      (`crm_private.client_timeline_items` + `public.get_client_timeline`).
- [x] Add artist-authorized open Next Action digest read.
- [x] Add idempotent notification enqueue on material Next Action.

## D. AI contracts and orchestration

- [x] Add structured client-state schema + prompt (`ai/client-state-schema.js`).
- [x] Add structured reference-image schema + prompt (`ai/reference-image-schema.js`).
- [x] Add `crm_client_state` task route.
- [x] Add `vision_reference_extraction` task route.
- [x] Add server-side job drain/orchestrator (`lib/crm-agent.js`) behind the
      existing production scheduler Service Binding.
- [x] Feed persisted vision summaries into client-state reasoning; a completed
      image analysis schedules the refresh that consumes it.
- [x] Preserve existing enquiry intake safety and source-of-truth semantics.

## E. Scheduling hooks

- [x] Schedule client-state refresh after durable enquiry changes.
- [x] Schedule client-state refresh after inbound communication messages.
- [x] Schedule client-state refresh when a conversation is linked to a client.
- [x] Schedule client-state refresh from Gmail when a thread advances
      (`20260910180000_crm_agent_gmail_hook.sql`).
- [x] Schedule vision jobs for eligible private enquiry image files.
- [x] Keep all hooks idempotent and non-blocking. Every trigger is AFTER and
      wrapped, so a queue problem cannot roll back the business write.

## F. Telegram / iPhone surface

- [x] Render actionable artist-only notification through existing notification path.
- [x] Expose bounded open-actions digest (`list_client_ai_next_actions`).
- [x] Add read-only Telegram command integration (`/needsme`, `/today`) via
      `20260910170000_crm_agent_telegram_digest.sql`.
- [x] Do not add autonomous client-send / booking / payment callbacks.

## G. Web references / Firecrawl

- [x] Reuse the existing web-research contract for external URLs.
- [x] Ensure private CRM storage URLs are never sent to Firecrawl. The CRM path
      emits no URL at all, and `normalizePublicUrl` now also rejects Supabase
      Storage URLs that arrive another way.
- [x] Associating an external reference URL to a client is deferred; see
      "Deferred" below.

## H. Validation

- [x] Add/extend SQL and JS tests (`supabase/tests/282_crm_agent_client_ai.sql`,
      `scripts/test-crm-agent.mjs`).
- [x] Extend the function-ACL allow-list in `supabase/tests/050_rls_roles.sql`.
- [x] Run available repository validation without deploying.
- [x] Fresh-check branch HEAD and review diff.
- [x] Record remaining rollout steps; do not deploy without explicit authorization.

## I. Corrective pass

- [x] Rebase onto the current trunk, preserving its enquiry-AI normalization.
- [x] Carry bounded Gmail reply content into the brief
      (`20260910190000_crm_agent_gmail_excerpts.sql`).
- [x] Schedule refreshes from canonical project/session/deposit changes
      (`20260910200000_crm_agent_canonical_facts.sql`).
- [x] Withhold stale recommendations from Telegram and withdraw their
      undelivered pushes (`20260910210000_crm_agent_stale_actions.sql`).
- [x] Replace the digest's temporary table with a CTE.
- [x] Align the visible `crm_facts` with the fields the watermark measures.
- [x] Repair the local DB harness so these suites are reproducible outside CI,
      and name its remaining divergence from `supabase test db` in the script.
- [x] Add an explicit CI gate for the CRM agent suite.

## Deferred

- Associating an external (public) reference URL to a client record. Firecrawl
  research works today through the GPT actions surface; binding its output to a
  client would need its own provenance and consent model, which is a larger
  question than this workstream.
- Telegram inline buttons and callback routing. The current bot contract has no
  callback handler, and adding one is a separate change from the read surface.
  Every button worth adding is an action, and actions stay in the CRM for now.
- A CRM web/mobile UI for the brief. The RPCs it needs exist and are grant-ready
  for `authenticated`; the admin bundle is not part of this branch.
