# Google review request after healing

Status: draft spec, not implemented. Requested by Vladimir on 2026-11-16.

## Problem
Happy clients rarely leave a Google review unless asked, and asking at the
wrong moment (mid-project, or while a tattoo is still healing badly) hurts.
The CRM has no signal that a tattoo healed well: the 24-hour
`post_session_checkin` email says "there is no need to reply if everything is
going well", and of the 5 check-ins sent between 2026-10-28 and 2026-11-12 none
received a healing reply (production data, 2026-11-16).

## Product rules (from Vladimir)
1. Two steps. First ask the client how the tattoo healed or is healing. Ask
   for a review only after the client has replied.
2. Both steps are **suggestions**. The CRM proposes; the artist decides
   whether, when and to whom to send. Nothing is sent automatically.
3. Many clients are in long multi-session projects, so the artist must be
   able to skip, postpone or never ask a given client.

## Flow

### Step 1: suggest a healing question
A suggestion appears on Today, section **Healing & reviews**, when all hold:
- the client's latest tattoo_session/touch_up has a confirmed visit outcome
  `attended` (`public.visit_outcomes`);
- at least 28 days (4 weeks, confirmed by Vladimir 2026-11-16) have passed
  since the last session of that consecutive block;
- the client has no future confirmed tattoo_session/touch_up;
- no healing question was sent, postponed past now, or dismissed for that
  block.

The card shows client, project, last session date and a pre-filled editable
message, e.g. "Hi {first_name}, how has your tattoo healed? If you can, send
me a photo in daylight. {artist}". Actions:
- **Send** (opens the editable text, then sends through the conversation's
  channel, see Channels);
- **Later** (hide for 14 days);
- **Don't ask** (never for this block).

The artist can also start step 1 manually from the client or project page at
any time, for example mid-project.

### Step 2: client replied
When an inbound message arrives in the same conversation within 21 days after
the healing question, Today shows **Replied about healing** with the reply
text and attachment thumbnails. Actions:
- **Ask for a review** -> step 3;
- **Needs attention** (no review, card moves to normal reply attention);
- **Don't ask** (close).

The artist judges whether the reply is positive. A later phase may add an AI
hint ("looks positive" / "mentions a problem"), never an automatic decision.
No reply within 21 days: the card closes silently.

### Step 3: review request
Pre-filled editable text with the artist's own Google review link, e.g.
"So glad it healed well! If you have a minute, a Google review would mean a
lot: {review_url}". Sent only when the artist presses Send.

One review request per client; a repeat is only possible manually from the
client page.

## Channels
- The message goes to the channel of the client's conversation (WhatsApp for
  60 of 63 linked clients, Instagram for 3), else email.
- WhatsApp outside the 24-hour customer window needs an approved template.
  Step 1 is usually outside the window (28+ days), so it needs a new utility
  template `vishar_healing_check_v1` (Utility, en_GB, one variable: client
  first name, two quick-reply buttons "Healed well" / "I have a question")
  submitted to Meta. The template never mentions reviews, so it stays
  Utility. A tap on "Healed well" is a structured positive reply for step 2;
  the artist still decides. Kristina's identity stays gated until her
  WhatsApp route exists. Step 3 is
  normally inside the window opened by the client's reply and uses the
  existing free-form path `queue_communication_message`.
- Submitting the template to Meta and activating it need Vladimir's explicit
  approval.

## Data
New table `public.review_requests` (RLS forced, no browser grants, access via
SECURITY DEFINER RPCs with per-artist checks): artist, client, anchor session
(last of block), state `suggested|snoozed|dismissed|healing_asked|replied|
review_asked|closed`, snoozed_until, healing_message_id, reply_message_id,
review_message_id, timestamps, version, operation-id idempotency.

Per-artist setting `google_review_url` (https, google.com / g.page domains
only). Seeded from the artists' own sites:
- Vladimir: `https://g.page/r/CRBB4T36uQ6wEBI/review` (vishar-site `index.html`);
- Kristina: `https://g.page/r/CTWQsqzepVfJEBI/review` (kisa `public/index.html`,
  `public/aftercare/index.html`).
Without it step 3 is disabled with a hint.

## Phases (one small PR each)
1. Table, RPCs (`list_review_suggestions`, `act_on_review_suggestion`),
   candidate query, pgTAP tests. No UI, no sends.
2. Today section and client-page entry; steps 2-3 via
   `queue_communication_message` and email drafts.
3. WhatsApp `healing_check_v1` template path (after Meta approval).

The Today section is a separate RPC and component, so `crm_private.pulse_items`
is not modified.

## Out of scope
Automatic sends, review-gating by rating, incentives for reviews, reading
Google reviews back.
