# Feature Specification: Unified enquiry communications

## Status

- Feature: `unified-communications`
- State: In implementation
- Owner/workstream: Vishar CRM
- Related PRs/issues: none at specification creation

## Problem

WhatsApp onboarding can finish with a blank Meta window or a callback without an authorization code, while the CRM collapses distinct provider failures into one generic error. The enquiry page also exposes a legacy WhatsApp-only panel that mixes opening an external app, creating a CRM conversation and connecting a provider account. WhatsApp, Instagram and email histories are therefore presented through different interaction models even when they belong to the same enquiry.

## Goals

- Restore Vladimir's production WhatsApp connection and prove inbound and outbound delivery with a real approved contact.
- Give Meta Embedded Signup failures a safe, specific diagnostic reason, including the provider step when available.
- Replace the enquiry's WhatsApp-only panel with one Communications surface for WhatsApp, Instagram and email.
- Link channel conversations to an enquiry before falling back to client-level matching.
- Preserve the existing Gmail thread and approval/queue pipeline while exposing email through the same frontend interaction model.
- Offer a channel-labelled chronological timeline after all three adapters are stable.

## Non-goals

- Changing, disconnecting or reprovisioning Kristina's Meta integration.
- Storing Meta or Gmail credentials in Postgres or browser state.
- Physically merging `email_messages` into the provider-neutral Meta message tables in the first release.
- Importing historical provider conversations or creating synthetic production clients for acceptance.
- Sending marketing broadcasts or bypassing current messaging-window, consent or approval rules.

## Actors and scope

- User/actor: an authenticated active CRM owner or artist-scoped manager with the required integration and communications capabilities.
- Artist/workspace scope: every read and mutation remains artist-scoped; stage 1 may mutate only Vladimir's WhatsApp provider binding and route.
- Environments affected: local and CI for implementation; production only through exact-SHA guarded rollout and real acceptance.

## User scenarios

### Scenario 1: Complete Vladimir's WhatsApp onboarding

Given Vladimir's enabled CRM route and an authorized operator, when Embedded Signup finishes and Meta returns a one-time code and the selected WABA, then the server validates the selection, writes only Vladimir's encrypted Worker bindings, subscribes the WABA and reports the connected identity without exposing credentials.

### Scenario 2: Diagnose an incomplete Meta flow

Given the Meta SDK opens but onboarding does not produce a usable code, when the flow cancels, errors, is blocked or returns an incomplete response, then the CRM displays a stable diagnostic reason that distinguishes SDK load, popup/login response, provider cancellation/error, missing WABA/phone data and timeout.

### Scenario 3: Communicate from an enquiry

Given an enquiry has a WhatsApp or Instagram conversation, when the user opens the enquiry, then the latest messages appear in one Communications block and the user can reply or open the full conversation using the common communications backend.

### Scenario 4: Use client-level fallback safely

Given no conversation is linked to the enquiry but one valid artist/channel conversation belongs to the same client, when the enquiry loads, then the server-authorized linking path may attach it to the enquiry; ambiguous or cross-artist matches fail closed.

### Scenario 5: Read and reply to email

Given an enquiry/client has Gmail thread context, when the user opens the Email channel, then the CRM presents the relevant thread and queues an approved outbound reply through the protected Gmail pipeline instead of sending directly from the browser.

## Functional requirements

- FR-001: Embedded Signup MUST use the currently configured Meta App ID and Configuration ID as one reviewed pair and MUST expose their non-secret identifiers for operator diagnosis.
- FR-002: The CRM MUST load the Meta SDK under the production CSP and launch `FB.login` synchronously from the user's tap on iPhone Safari.
- FR-003: Embedded Signup MUST preserve safe evidence from the login callback and `WA_EMBEDDED_SIGNUP` event until the flow reaches success or a specific terminal failure.
- FR-004: A successful onboarding MUST require both a one-time authorization code and a valid finish event, with server-side WABA/phone verification before binding writes.
- FR-005: Stage 1 production provisioning MUST target Vladimir only and MUST leave Kristina's route, encrypted bindings and provider subscription unchanged.
- FR-006: The enquiry page MUST show one Communications block with explicit Email, WhatsApp and Instagram availability/connection states.
- FR-007: WhatsApp and Instagram MUST share the existing `communication_conversations` and `communication_messages` backend and prefer `enquiry_id` lookup over client fallback.
- FR-008: The enquiry Communications block MUST show recent messages, support a reply and provide an action to open the full conversation.
- FR-009: Email MUST retain `email_messages` and Gmail thread context while a frontend adapter exposes a conversation/message-shaped interface.
- FR-010: Email replies from an enquiry MUST enter the existing approved/queued Gmail pipeline and MUST NOT be sent directly from the browser.
- FR-011: The final enquiry view MUST offer a timestamp-ordered timeline with a visible channel label on every item.
- FR-012: The legacy `EnquiryWhatsAppPanel` MUST be removed only after the common Communications UI covers its supported behavior.
- FR-013: New and changed interface copy MUST work in English and Russian and remain usable on a narrow mobile viewport.

## Security and trust requirements

- SR-001: A browser may name an artist or conversation only as a request; server-side authorization and durable ownership MUST resolve the actual artist, integration and recipient.
- SR-002: Provider credentials, authorization codes, WABA/phone identifiers and Gmail tokens MUST remain outside Postgres-readable configuration, UI state after use, logs and audit metadata.
- SR-003: WhatsApp inbound routing MUST continue to require the signed payload plus the exact artist-owned WABA/phone binding; unknown or ambiguous routes fail closed.
- SR-004: WhatsApp/Instagram outbound routing MUST continue to recompute artist, channel, integration selector and recipient from authoritative conversation/message rows.
- SR-005: Enquiry/client linking MUST reject cross-artist ownership, unauthorized actors and ambiguous client-level matches.
- SR-006: Gmail replies MUST retain existing authorization, approval, idempotency and outbox rules.
- SR-007: Activity records MUST not contain message bodies, participant identifiers or provider credentials.

## Failure and recovery behavior

- SDK load, CSP/frame, popup/login response, provider cancel, provider error, missing code, missing WABA/phone and timeout failures remain separate user-visible diagnostic categories.
- No Worker binding or Meta subscription changes occur until authorization, artist capability, enabled route, code exchange and selected WABA/phone validation all pass.
- If the first Worker binding write succeeds and a later provisioning step fails, the route is not declared connected; rerunning onboarding overwrites only the same Vladimir-scoped binding names.
- Provider delivery failure does not remove a durable enquiry or message. Existing outbox retry/dead-letter behavior remains authoritative.
- Ambiguous client fallback leaves the conversation unlinked and tells the user that manual review is required.

## Data and retention expectations

Meta conversations remain in `communication_conversations` and `communication_messages`. Email stays in `email_messages` plus the current private Gmail thread context. No provider token or expiring media URL is added to either model. Existing retention and append-only activity rules continue to apply.

## Acceptance criteria

- AC-001: On iPhone Safari, Vladimir can finish Meta login and the CRM receives a non-empty authorization code plus a valid finish event.
- AC-002: Production readback shows only Vladimir's intended encrypted WhatsApp binding names were refreshed and his safe route metadata remains enabled with empty configuration.
- AC-003: A real inbound WhatsApp message from an approved other number creates or updates the correct Vladimir conversation and appears in CRM.
- AC-004: A reply sent from CRM reaches that approved number and the outbox/message state records provider acknowledgement without storing response bodies.
- AC-005: Kristina's WhatsApp safe metadata, secret-name set and observed delivery state remain unchanged through stage 1.
- AC-006: An enquiry with WhatsApp and/or Instagram history shows the latest messages and reply/open actions in one Communications block.
- AC-007: A client-level conversation is linked only through the authorized, unambiguous, same-artist path.
- AC-008: Email history and reply work through the Gmail adapter without changing the physical Meta message model.
- AC-009: The final unified timeline is ordered by timestamp, channel-labelled, translated in RU/EN and validated on mobile.
- AC-010: Exact-head required CI is green and the production Pages deployment readback reports the released SHA.

## Dependencies and constraints

- Meta App and Embedded Signup configuration must be active and correctly paired in the Meta account.
- The production CRM stays behind Cloudflare Access; the WhatsApp webhook remains publicly reachable only at its exact callback route.
- Real provider acceptance requires the user's existing Meta session and one explicitly approved test contact.
- Production schema is currently through migration `0117`; stage 1 requires no database migration.

## Open questions

- Whether the current Meta Configuration ID is a v3 or v4 Embedded Signup configuration must be verified in Meta before final production acceptance; code will not guess or replace it.
- Physical consolidation of email and Meta tables is intentionally deferred until the adapter UI has production evidence.

## Requirement changes

- 2026-08-30: Initial durable specification created from the approved five-stage execution order.
