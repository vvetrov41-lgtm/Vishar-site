# Feature Specification: Enquiry discovery attribution

## Status

- Feature: `enquiry-discovery-source`
- State: Clarified
- Owner/workstream: Vishar CRM
- Related PRs/issues: none

## Problem

The public booking form records technical acquisition data such as booking source and UTM values, but it does not ask clients how they first discovered the artist. The Statistics screen therefore cannot answer the separate business question "How did clients hear about you?" for Vladimir, Kristina, or Sam.

## Goals

- Collect one self-reported discovery category on every new canonical `/book/{artist}` submission.
- Preserve the answer on the enquiry without changing artist/source routing authority.
- Show a separate artist-scoped Statistics breakdown for self-reported discovery source.
- Keep historical and legacy/external intake compatible when no answer exists.

## Non-goals

- Replacing or changing the existing technical "Where enquiries came from" breakdown.
- Inferring a discovery source from UTM, referrer, message channel, or booking source.
- Advertising attribution, external analytics export, or customer profiling.
- Backfilling historical enquiries with guessed values.

## Actors and scope

- User/actor: prospective client submitting a public booking form; authenticated CRM staff viewing Statistics.
- Artist/workspace scope: the enquiry remains scoped to the server-resolved artist. Statistics remains constrained by existing RLS and artist membership.
- Environments affected: CI, staging/production Supabase, TattooAI/public booking Worker, CRM Pages.

## User scenarios

### Scenario 1: New public booking

Given a valid `/book/vladimir`, `/book/kristina`, or `/book/sam` form, when the client selects how they heard about the artist and submits, then the enquiry stores that category and routes to the artist selected by the server-owned public booking URL.

### Scenario 2: Statistics

Given an authenticated CRM user who can view enquiries for an artist, when they open Statistics for a period, then they see a separate "How clients heard about you" breakdown for that artist and period, including enquiries where the answer was not recorded.

### Scenario 3: Legacy compatibility

Given an older or external supported intake that does not submit the new field, when it creates an enquiry, then intake still succeeds and the discovery source is stored as not recorded.

### Scenario 4: Invalid client input

Given a submission with an unsupported non-empty discovery category, when it reaches intake validation, then it is rejected and no customer/enquiry mutation is committed.

## Functional requirements

- FR-001: Canonical public booking pages MUST present a required discovery-source selector with stable choices: Instagram, ChatGPT, Other AI assistant, Friend / recommendation, Google, Other.
- FR-002: The durable enquiry record MUST store the stable category independently from technical acquisition fields.
- FR-003: Existing intake clients MAY omit the field and MUST remain compatible.
- FR-004: Statistics MUST aggregate the stored value for the selected artist and selected period, without altering the existing technical-source calculation.
- FR-005: Historical enquiries with no value MUST be represented as "Not recorded" / "Не указано" in the discovery breakdown.
- FR-006: The feature MUST work identically for Vladimir, Kristina, and Sam through the shared canonical booking form.

## Security and trust requirements

- SR-001: The discovery answer is descriptive business metadata only and MUST NOT select or override `artist_id`, `booking_source_id`, source keys, form versions, origins, or provider routing.
- SR-002: Artist and booking-source ownership MUST continue to be resolved server-side from the trusted public booking route/source registry.
- SR-003: Statistics MUST rely on the existing database/RLS artist scope rather than browser-side filtering as an authorization boundary.
- SR-004: The database MUST constrain stored non-null values to the supported stable category ids.

## Failure and recovery behavior

- Invalid non-empty values fail validation before durable intake.
- Missing values from compatible legacy/external forms are stored as NULL.
- Existing idempotent intake semantics remain unchanged; the discovery value participates in the submitted enquiry payload fingerprint.
- A failed database/Worker/CRM deployment is fail-closed and must not be treated as complete until readback and acceptance succeed.

## Data and retention expectations

`discovery_source` is stored on the existing enquiry record and follows the enquiry's existing retention, RLS, and archival behavior. It is used only for CRM operational reporting in this feature. Historical records are not guessed or rewritten.

## Acceptance criteria

- AC-001: `/book/vladimir`, `/book/kristina`, and `/book/sam` render the same required discovery-source selector with the six supported choices.
- AC-002: A valid hosted public booking intake persists the selected stable category on the matching enquiry.
- AC-003: Unsupported discovery values are rejected and cannot be persisted.
- AC-004: Omitted discovery values remain accepted for compatible non-canonical/legacy intake and persist as NULL.
- AC-005: Statistics shows a separate artist-scoped discovery breakdown for the selected period and labels NULL as not recorded.
- AC-006: Existing technical source statistics retain their current semantics.
- AC-007: Forged browser routing fields still cannot change artist/source ownership.
- AC-008: Exact-head CI, production migration readback, Worker/Pages rollout, and read-only acceptance are green before production completion is declared.

## Dependencies and constraints

- Existing trusted booking-source intake and public booking slug architecture.
- Existing Statistics screen and artist-scoped RLS.
- Ordered forward-only Supabase migrations.

## Open questions

- None.

## Requirement changes

- 2026-09-05: Initial clarified scope. Self-reported discovery is intentionally separate from technical source attribution.