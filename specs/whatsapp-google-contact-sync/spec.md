# Feature Specification: WhatsApp-linked Google Contact sync

## Status

- Feature: `whatsapp-google-contact-sync`
- State: Clarified
- Owner/workstream: ChatGPT / Vishar CRM
- Related PRs/issues: none yet

## Problem

Vishar CRM can receive and link WhatsApp conversations to CRM clients, but the linked client's phone number is not automatically added to the artist's address book. Meta's public WhatsApp Cloud API does not provide a general server-side operation to save a sender into the user's WhatsApp address book. The practical supported path is to create a normal Google contact in the artist's authorised Google account so that a device syncing that account can expose the saved contact to WhatsApp.

## Goals

- Automatically create a Google contact when an authoritative WhatsApp conversation becomes linked to a CRM client.
- Keep WhatsApp ingestion and client linkage independent from Google availability.
- Prevent duplicate contacts and avoid modifying pre-existing personal contacts.
- Reuse the existing server-side Google OAuth/token custody architecture without exposing provider credentials to the CRM browser or Postgres.
- Keep the behavior tenant/artist scoped so each artist writes only to their own authorised Google account.

## Non-goals

- Directly creating a contact inside WhatsApp or Meta's private/internal address book.
- Creating contacts for unmatched/unknown inbound WhatsApp numbers.
- Creating contacts from Instagram, email, Telegram, or unlinked conversations in this workstream.
- Editing, deleting, merging, or renaming an existing Google contact that Vishar CRM did not create.
- Making Google Contacts authoritative for CRM client data.
- Guaranteeing device-level WhatsApp display if the artist's phone is not configured to sync the authorised Google Contacts account.

## Actors and scope

- User/actor: Vishar CRM artist/operator with an authorised Google account.
- Artist/workspace scope: the client and WhatsApp conversation MUST belong to the same authoritative artist/workspace; the Google account MUST be the one authorised for that artist.
- Environments affected: CI, validation/staging path, production.

## User scenarios

### Scenario 1: linked WhatsApp client is added safely

Given a WhatsApp conversation has been authoritatively linked by CRM to a non-archived client with a valid normalized phone number and usable full name, when the link is first established, then CRM queues a background Google Contacts projection for the owning artist. If no Google contact with that exact canonical phone number exists, the system creates one using only the approved CRM contact fields.

### Scenario 2: contact already exists

Given the artist's Google Contacts already contains a contact with the exact canonical phone number, when a linked WhatsApp client is processed, then the system treats the projection as satisfied and does not create a duplicate or overwrite the existing contact.

### Scenario 3: Google is unavailable or scope is missing

Given WhatsApp linkage succeeds but Google Contacts is unavailable, rate-limited, the OAuth token is expired, or the Contacts scope has not been granted, when the projection runs, then the WhatsApp conversation and CRM client remain linked and usable. The provider failure is recorded through bounded outbox retry/dead-letter behavior.

### Scenario 4: untrusted/unmatched inbound WhatsApp sender

Given a raw inbound WhatsApp message has not been authoritatively linked to a CRM client, when webhook ingestion completes, then no Google Contact job is created.

### Scenario 5: cross-artist or stale route

Given an outbox row or provider request does not resolve to the authoritative owning artist and that artist's active authorised Google account, when the worker processes it, then the operation fails closed without writing any Google contact.

## Functional requirements

- FR-001: The system MUST enqueue contact sync only when a WhatsApp conversation transitions into an authoritative linked state with a non-null CRM `client_id`.
- FR-002: The enqueue path MUST NOT make a provider network call and MUST NOT make WhatsApp ingestion/linkage depend on Google availability.
- FR-003: The queued job MUST carry only identifiers and routing/version metadata needed for processing; current name/phone/email MUST be read from authoritative CRM state at processing time rather than trusted from webhook input.
- FR-004: The provider worker MUST require a non-archived client, a valid normalized phone number, and a non-empty bounded display name before creating a Google contact.
- FR-005: Before create, the worker MUST search the artist's Google Contacts and compare returned canonical phone numbers to the CRM normalized phone. An exact match MUST suppress creation.
- FR-006: A new Google contact MUST contain only the CRM full name, normalized phone number, and optional client email. Tattoo/enquiry/message/project details MUST NOT be copied to Google Contacts.
- FR-007: Contact creation MUST be idempotent across retries, including the case where Google accepted a create but CRM failed before acknowledging the outbox job.
- FR-008: Jobs MUST use bounded claim/lease, retry, terminal/dead-letter, and acknowledgement semantics consistent with the existing integration outbox architecture.
- FR-009: Google Contact mutation MUST use the Google account authorised for the job's owning artist. Cross-artist token/account use MUST fail closed.
- FR-010: The existing Google OAuth flow MUST explicitly request the Contacts write scope before Contacts mutation can run.
- FR-011: Disconnecting/invalidating the artist's Google integration MUST prevent future contact mutations.
- FR-012: The system SHOULD expose enough safe operational state to distinguish success, existing-contact skip, invalid-client skip, retryable provider failure, and terminal authorization/configuration failure without logging contact content.

## Security and trust requirements

- SR-001: Raw webhook fields, WhatsApp sender labels, browser fields, and outbox payload data MUST NOT authoritatively choose artist, workspace, Google account, or provider credential.
- SR-002: The client/artist/workspace relationship MUST be revalidated from trusted database state before a provider mutation.
- SR-003: Google refresh tokens, client secrets, encryption material, and access tokens MUST remain Worker/KV/server-side and MUST NOT be stored in Postgres, returned to CRM, or logged.
- SR-004: Service-role RPCs used by the provider worker MUST be narrowly scoped, backend-only, and return the minimum contact projection required for this feature.
- SR-005: Existing RLS, membership, capability, workspace isolation, and provider-account pinning MUST not be weakened.
- SR-006: Existing personal Google contacts MUST not be changed merely because their phone matches a CRM client.
- SR-007: Activity/log records MUST avoid phone numbers, email addresses, contact names, WhatsApp message content, and Google token material.

## Failure and recovery behavior

- Provider timeout, 429, and transient 5xx responses retry with the bounded outbox policy.
- OAuth expiry or missing Contacts permission fails closed and remains operationally visible; it never rolls back or blocks WhatsApp/CRM state.
- A retry always performs duplicate detection before create so provider success followed by acknowledgement failure cannot create repeated contacts.
- Invalid/archived clients or clients with no valid normalized phone are safely skipped/terminal according to the final implementation contract and never sent to Google.
- Existing matching Google contacts are success-equivalent skips, not errors.

## Data and retention expectations

- CRM client data remains authoritative in Supabase.
- The outbox stores identifiers and minimal routing/version metadata, not a durable copy of client PII where avoidable.
- Provider identifiers may be stored only if needed for operational evidence and must not be treated as credentials.
- No Google refresh/access token is stored in Supabase.
- Existing CRM retention/archive rules remain authoritative; this version does not automatically delete Google contacts when a CRM client is archived.

## Acceptance criteria

- AC-001: A newly linked WhatsApp conversation for a legitimate CRM client produces exactly one eligible Contacts projection job for the owning artist.
- AC-002: Reprocessing the same job, including after an ambiguous provider acknowledgement, does not produce duplicate Google contacts for the same canonical phone number.
- AC-003: A pre-existing Google contact with the same canonical phone is left unchanged and no duplicate is created.
- AC-004: An unmatched WhatsApp conversation cannot enqueue a Contacts job.
- AC-005: Cross-artist/provider-route manipulation is denied and covered by a denial test.
- AC-006: Google outage/scope failure leaves WhatsApp conversation/client state intact and results in bounded retry/terminal evidence.
- AC-007: Provider calls contain only the approved contact fields and no tattoo, enquiry, project, message, note, or payment data.
- AC-008: Exact-head CI passes for the implementation SHA.
- AC-009: Production rollout, when authorised, is verified by migration/deployment readback and a legitimate existing/newly linked client path or another non-fabricated controlled acceptance path.
- AC-010: The operator-facing Google connection/consent surface accurately discloses that Contacts access is required for automatic client contact sync.
- AC-011: GPT/operator parity is explicitly classified; the provider consent screen remains human/UI-only while the background sync itself requires no manual GPT action.

## Dependencies and constraints

- Google People API `people.searchContacts` and `people.createContact`.
- OAuth scope `https://www.googleapis.com/auth/contacts`.
- Existing Vishar Google OAuth token custody and per-artist Google-account pinning.
- Existing `integration_outbox` claim/lease/retry infrastructure.
- On iPhone/WhatsApp, the authorised Google account must be enabled as a Contacts source for the saved contact to appear in the device address book.
- Current staging Supabase is materially behind production migration history, so staging must not be treated as a safe schema mirror until the release path reconciles that drift.

## Open questions

- None blocking. Implementation may choose the narrowest production-compatible way to share the existing Google OAuth/token custody while keeping the Contacts capability explicit and fail-closed.

## Requirement changes

- 2026-09-17: Initial clarified scope created from the requested WhatsApp-contact automation and current production architecture.
