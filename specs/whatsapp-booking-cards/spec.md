# Multichannel booking cards

## Product rules

One server-owned booking-card event can render to either supported client channel:
- email;
- WhatsApp.

A card is delivered in exactly one channel: the one the client actually talks
to the studio in (see "Conversation channel" below). It is never sent to Email
and WhatsApp at the same time, and contact details alone never pick a channel.

The channels must share the same authoritative appointment/payment facts and client-action semantics. Provider-specific rendering must never recalculate business data.

### Tattoo sessions

A tattoo booking card is eligible only when:
- the appointment is a future confirmed `tattoo_session`;
- the authoritative CRM payment state proves the applicable deposit has been paid;
- the booked session has an explicit authoritative `session.price`.

Never infer payment or price from a message, note, screenshot, client statement, or an arbitrary estimate.

The card shows:
- client first name;
- artist display name;
- appointment date and start time in the artist timezone;
- deposit paid;
- remaining balance;
- studio location.

A paid deposit must not create duplicate cards if the payment webhook/reconciliation is replayed.

### Unified pricing rule

All artists use the same booking-card pricing contract:

- `sessions.price` is the authoritative total price of that specific tattoo session.
- Remaining balance is always `max(0, session.price - deposit_paid_for_session)`.
- No renderer recalculates the session total from hourly rate, full-day rate, project estimate, or artist identity.
- The booking/edit flow exposes one explicit session-price field for every paid appointment, regardless of artist.
- Before a tattoo booking can produce a paid-deposit card, `session.price` must be filled in.
- A multi-session project estimate must never be divided automatically between sessions.
- Hourly rates and full-day rates may help the artist decide what to enter, but the booking-card system never derives a price from them.
- Consultations cannot carry `session.price`.

This is intentionally the same rule for Vladimir, Kristina, and future artists. Artist-specific pricing formulas are not part of the card system.

Example:
- session price: £980;
- deposit paid: £250;
- remaining balance: £730.

### Consultations

- In-person consultations are completely free.
- There is no consultation deposit and no consultation balance.
- Consultation cards must never contain deposit wording, payment wording, price, or remaining balance.
- A consultation card is triggered by a future confirmed `in_person_consultation`, not by payment state.

## Channel behavior

### Email

Email must be built as a real visual card rather than another block of plain text.

Requirements:
- send a multipart email with a plain-text fallback and an HTML card;
- keep the same subject/body facts as WhatsApp;
- include two visible action buttons:
  - `I'll be there`;
  - `Need another time`;
- buttons use the existing secure one-time appointment-action URL model;
- no cancel button in these booking cards;
- include a location/address link rather than requiring an embedded map image;
- email-provider failure must not block WhatsApp delivery or mutate booking/payment state.

The existing Gmail transport currently sends `text/plain` only, so HTML/multipart MIME support is part of this workstream.

### WhatsApp

WhatsApp uses an approved Utility template when the send occurs outside the customer-service window.

Requirements:
- use a native location header when the approved Meta template supports it;
- expose exactly two quick replies:
  - `I'll be there`;
  - `Need another time`;
- quick replies carry opaque one-time capabilities, never raw client/session ids;
- WhatsApp-provider failure must not block email delivery or mutate booking/payment state.

## Client actions

Both channels have identical semantics.

### I'll be there

- records `attendance_confirmed` for the current calendar version;
- does not change appointment time or lifecycle status.

### Need another time

- records `reschedule_requested`;
- leaves the current appointment booked at its existing time;
- raises operator attention so the artist can offer alternative dates;
- never auto-selects or moves to another slot.

Each delivery gets its own two-action capability pair. A response on either channel invalidates every remaining sibling capability for the same session/version, so contradictory responses cannot both apply. This also means retrying one failed channel never breaks action links already delivered through the other channel.

## Event and delivery model

- One canonical booking-card record/event is created per session/card reason/calendar version.
- canonical card -> resolve the conversation channel -> at most one delivery.
- The delivery has a durable state and idempotency key. Retries, reconciliation
  and later conversations never add a delivery in a second channel; the
  database refuses a sibling delivery.
- No second-channel delivery intent is created and then skipped: when the
  channel is resolved, only that channel is materialised.
- Cards created before 2026-09-27 may still carry an Email and a WhatsApp row
  from the earlier fan-out model.

### Conversation channel

The CRM has no separate "preferred conversation channel" field; the form's
"preferred contact" is a stated preference, not a conversation, and is not used.
The channel is the newest real conversation evidence for this client with this
artist ("latest conversation channel wins"):

- WhatsApp / Instagram: linked conversation messages that are inbound, or
  outbound by a person (CRM or provider app). Automated messages, including
  booking cards and reminders, never count.
- Email: CRM email to the client actually sent by a person or the assistant
  (system mail such as deposit requests does not count), a recorded Gmail
  message, a Gmail metadata snapshot, or a Gmail thread with the client (first
  observed time, because re-reading a thread moves its update time).

Outcomes, recorded per card revision with channel, reason, evidence source,
conversation/message ids and decision time, never message content:

| Outcome | Delivery |
|---|---|
| `selected` | one delivery in that channel |
| `no_conversation_channel` | none; CRM shows "Booking card: no conversation channel yet" |
| `conversation_channel_unsupported` | none; newest conversation is Instagram, no fallback |
| `conversation_channel_disabled` | none; card sending is off for that channel, no fallback |
| `conversation_channel_unreachable` | none; e.g. the WhatsApp conversation is not with the client's number |
| `delivery_unavailable` | none; the channel could not be materialised (e.g. template missing) |

A blocked card is re-resolved when new conversation evidence for the client
appears (a message, a linked conversation, a sent email, a Gmail thread,
excerpt or snapshot). The rollout window still applies: appointments before
the artist's activation date never get cards retroactively.
- A later appointment date/time mutation invalidates old client-action capabilities.
- Reissuing a card after a real schedule change uses the new calendar version.

### Tattoo trigger

The card becomes eligible when all tattoo conditions are simultaneously true, regardless of whether payment or booking confirmation happened first.

### Consultation trigger

The card becomes eligible when the consultation becomes a future confirmed consultation.

## Location

Current intended studio:
- Label Tattoo Private
- 16 Exhibition House, Addison Bridge Place
- London W14 8XP

Location data must be server-owned configuration, not client-controlled message fields.

## AI layer

The AI layer covers booking cards as context and follow-up orchestration, not as the source of booking facts.

Deterministic/server-owned responsibilities:
- whether a card is eligible to send;
- appointment type, date, time, artist and location;
- `session.price`;
- paid-deposit amount and remaining balance;
- template selection and provider payload;
- one-time button capability issuance;
- applying `attendance_confirmed` and `reschedule_requested`;
- idempotency and stale-calendar-version rejection.

AI responsibilities:
- consume card delivery and client-response events into the client brief/timeline;
- understand that `attendance_confirmed` means no attendance follow-up is required for that appointment version;
- surface `reschedule_requested` in attention/Today context;
- help draft the artist's reply with alternative dates after a reschedule request, subject to normal allowed-actions and approval/send boundaries;
- answer operator questions such as whether the client confirmed, requested another time, or was sent a booking card.

The model must never invent or override price, deposit state, appointment time, card eligibility, or a client button result. A model failure must not prevent the deterministic card/button path from working.

## Security and correctness

- Client actions use opaque one-time capability values.
- Capabilities are bound to one session and one `calendar_version`.
- Booking-card capabilities expire no later than seven days after issuance or at appointment start, whichever comes first.
- Rescheduling or another lifecycle mutation invalidates stale actions.
- Provider webhooks and outbox processing are idempotent.
- GET/link scanners must not mutate appointment state.
- No production customer data is created for acceptance tests.
- Delivery content comes from reviewed templates/renderers, not free-form AI generation.

## Rollout

1. Make explicit `session.price` the unified tattoo-session price source and add validation/prefill in booking/edit flows.
2. Add the canonical booking-card record/outbox contract with both channels disabled.
3. Add Gmail multipart text+HTML card transport.
4. Add Meta Utility-template transport and WhatsApp quick-reply ingestion.
5. Add channel-safe client-action capability issuance for email links and WhatsApp quick replies.
6. Create/read back approved Meta Utility templates.
7. Enable consultation cards on email and WhatsApp.
8. Enable tattoo paid-deposit cards on email and WhatsApp.
9. Verify production delivery/readback independently for both channels using legitimate existing events or controlled operator probes.
10. Route each card to one conversation channel (latest conversation wins,
    fail closed without a conversation, no Instagram fallback) and resolve
    booking-card Email in the Gmail outbox target (it may have no enquiry).
