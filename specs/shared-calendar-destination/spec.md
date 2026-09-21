# Feature Specification: Shared Google Calendar destination

## Status
- Feature: shared-calendar-destination
- Target: production Vishar CRM Calendar projection
- Base: `agent/platform-telegram-self-service` @ `eb5c7919600bafbfcceed3f3bb29909031ba154c`

## Problem
Vladimir and Kristina have separate OAuth accounts, but the studio needs their CRM appointments visible in the same Google Calendar. Existing code hard-rejects every destination except `primary`, so new Kristina appointments disappear from Vladimir's visible studio calendar even though older manually moved events are there.

## Required behavior
- Keep Supabase appointments authoritative.
- Keep Vladimir and Kristina OAuth credentials separate and artist-scoped.
- Read the destination only from backend-owned `artist_integrations.configuration.calendar_id`.
- Project both artists to `info@labeltattooprivate.co.uk`.
- Preserve artist-first event titles and existing Blueberry/Wisteria presentation.
- Because event-label ids are calendar-specific, use the verified shared-calendar Wisteria id for Kristina.
- When a record is reprojected to a non-primary destination, delete the deterministic CRM projection from the artist's old primary calendar after the destination write succeeds.
- New/future artists continue to default to `primary` unless server configuration selects another destination.

## Safety
- No browser or GPT input may choose a Calendar account or destination.
- No OAuth token or secret enters Supabase.
- Target writes are idempotent; cleanup runs only after the target write succeeds.
- A target or cleanup provider failure is recorded through the existing durable outbox instead of changing the appointment itself.

## Acceptance
- exact-head Worker and pgTAP tests green;
- Worker deployed before destination metadata changes;
- production config readback shows both current artists targeting the shared calendar;
- Claudia Loi 8 Nov reprojects into the shared calendar and disappears from Kristina's primary projection;
- future Vladimir/Kristina appointments land in the shared calendar with artist name first.
