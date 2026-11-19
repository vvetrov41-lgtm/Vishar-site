# Reply drafts in the artist's voice

## Problem (production, 2026-11-18)

Vladimir answers clients by hand, mostly from the WhatsApp and Instagram apps.
The CRM already produces reply drafts, but nobody uses them:

- `crm_draft_reply` (`workers/lib/crm-agent.js`) wrote 786 drafts into
  `client_ai_next_actions.draft_reply` since 2026-09. None was sent
  (no outbound message within 3 days starts with the draft's first 40 chars),
  and no screen shows them.
- The drafts do not sound like the artist ("I'm excited to start working on
  your tattoo", asking the client how many hours they want). The prompt has no
  example of how the artist actually writes.
- The digit guard missed "2-3 sessions would be ideal" (2026-11-18).

Corpus available for examples (read-only query, 2026-11-18):

- 1,701 outbound texts by Vladimir; 1,275 (75%) are in conversations marked
  not-CRM (`communication_conversations.not_crm_at`) and must never be used.
- Client conversations: 105, with 636 inbound and 426 outbound texts
  (WhatsApp 272, Instagram 154). 46 Instagram outbound texts are one canned
  welcome ("Hi! Thanks for your message. ...") and are excluded.
  About 380 usable examples remain.
- Kristina has 87 Instagram replies: too few for her own voice in v1.
- Median reply time 32 minutes; 37 of 288 replies (13%) came after 24 hours,
  when a CRM WhatsApp send is already outside the service window.

## Behaviour

- **One button, one draft.** In a client conversation the composer offers
  "Suggest reply". It fills the reply box with one draft. The artist edits and
  presses the existing Send; the existing pre-send review still runs.
  Nothing is sent, queued or scheduled by the draft itself.
- **Context.** The newest 20 messages of the conversation, the client brief
  when one exists, and up to 5 past replies by the same artist to similar
  client messages.
- **Examples** come only from the same artist's own client conversations:
  not-CRM conversations, automation, templates, reactions, media and the
  canned Instagram welcome are excluded. Phone numbers, email addresses and
  bank details are masked before any model sees them.
- **Voice.** A versioned style file in the repository (length, greetings,
  sign-off emoji, what the artist never promises) plus the examples.
  The draft follows the client's language.
- **Facts.** Every number in a draft must appear in the conversation or in the
  artist's standard facts. Otherwise the draft is rejected, never trimmed.
  Standard facts (Vladimir, 2026-11-19: "only rates"): hourly rate £140 and
  day rate £980 for 7 hours. Project estimates, dates, availability, deposits
  and payment details stay the artist's to write.
- **Consultation** is not offered by default. A draft may suggest the free
  consultation at the West Kensington studio only when the client's latest
  messages show doubt (unsure about the design, the placement, a cover-up
  or whether to go ahead).
- **Window.** When the WhatsApp service window is closed the button says so
  before drafting; the composer's existing failure path is unchanged.
- **Not offered** in not-CRM conversations, archived conversations, or for an
  artist without the feature flag `REPLY_DRAFTS_ENABLED`.
- **Measured.** Each draft is stored with the text actually sent from that
  composer, so the share of drafts sent with small edits can be tracked.

## Out of scope

- Automatic sending of any kind, including "simple" questions.
- Email drafts (they have their own flow in `email_messages`).
- Changing or removing the background `crm_draft_reply` before the new path
  has a week of measurements.
- Kristina's voice.
