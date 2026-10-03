# Booking card confirmation

## Status
In implementation. Requested 2026-10-03 by the operator.

## Problem and goals
Booking status `confirmed` reserves the slot but does not prove client attendance.
Automatic email cards currently start a separate conversation.

## Actors and scope
Artists and their RLS-authorised appointments; Gmail mailbox and recipient remain
server-resolved. Code/CI only until production rollout is separately approved.

## Requirements and scenarios
- FR-001: The appointment's visible status distinguishes awaiting attendance,
  confirmed attendance and requested reschedule, in calendar and client views.
- FR-002: Only a response for the current calendar version is displayed; inactive
  appointments retain cancelled/completed/no-show status.
- FR-003: Booking-card email replies in the latest existing bilateral conversation
  with that client that contains an inbound message and usable reply headers.
  No such conversation means a standalone card. Subject and HTML are preserved
  appropriately: reply uses the conversation subject, HTML remains the card.
- FR-004: No extra email notifications, synthetic client replies, manual response
  changes or re-sending historical cards.
- SR-001: Only server-proven booking-card jobs receive automatic thread discovery.
  Existing lease, artist/client route, credential and obsolete-card checks remain.
- SR-002: Gmail participant validation, MIME header validation, idempotent message
  id and retry/acknowledgement behavior remain authoritative.

## Failure and recovery
Provider errors retry through the existing outbox; they never erase a booking.
No suitable thread is a normal standalone fallback, not a delivery failure.

## Acceptance
- AC-001: Current client response replaces the ambiguous visible status; stale
  responses and completed/cancelled appointments do not appear confirmed by client.
- AC-002: MIME reply carries threadId, In-Reply-To, References and original subject.
- AC-003: Non-card jobs do not search automatically; routing denials still fail.
- AC-004: Targeted/full tests, typecheck and build pass. Production remains separate.

## Non-goals and open questions
No spam/read tracking, new appointment enum, new operator writes or extra email.
No open product questions. Provider UI grouping is ultimately client-dependent.
