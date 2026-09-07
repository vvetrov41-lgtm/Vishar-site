# Single-profile Telegram enquiry delivery

## Requirement change

Production must expose one Telegram connection in the CRM Notifications section. The signed-in artist profile connection receives both new enquiry alerts and personal CRM notifications. A second artist/group connection is no longer required for this product flow.

## Goals

- A completed enquiry remains durable regardless of Telegram availability.
- Its existing Telegram outbox job creates one deduplicated profile notification for the active artist profile.
- The established personal Telegram queue performs the only provider call.
- Delivery state and destination health remain queryable without exposing chat IDs.
- A dead destination-unavailable job can be recovered only when no prior success or notification evidence exists.

## Non-goals

- No synthetic enquiry or destination.
- No chat-id migration or destination substitution.
- No change to retained legacy staging bindings.
- No generic operator retry endpoint.

## Acceptance criteria

1. Notifications shows one Telegram card.
2. A production enquiry outbox job performs no direct Telegram API call.
3. The personal queue creates one delivery row, sends once under its existing lease/dedupe contract, and updates last_success_at on success.
4. Missing profile destination fails closed with telegram_destination_unavailable.
5. Recovery rejects any job with prior outbox success or enquiry notification evidence.
6. Browser roles cannot call routing or recovery RPCs.
7. The Dmitriy job succeeds after guarded recovery, and readback confirms the delivery and last_success_at.
