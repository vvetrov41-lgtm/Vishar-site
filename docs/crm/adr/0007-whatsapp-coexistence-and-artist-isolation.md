# ADR 0007: WhatsApp Business Platform coexistence and artist isolation

Status: proposed, code prepared but no Meta account, phone number, credential or runtime is connected

Supersedes nothing. Extends ADR 0005 (Telegram automatic drain) from a
notification connector to a two-way messaging connector, and reuses the
artist-scoped provider routing established in ADR 0003.

## Context

Vladimir and Kristina each already run the WhatsApp Business app on their own
phone number, and both intend to keep doing so. The requirement is not to
replace that with an API integration; it is to let the CRM see and participate
in the same conversations without taking the number away from the phone.

Meta supports exactly this, and the design below depends on it being true, so
each load-bearing claim was checked against current official documentation
rather than assumed.

- **Coexistence exists and is official.** Embedded Signup accepts
  `featureType: whatsapp_business_app_onboarding`, documented as onboarding a
  business "using their existing WhatsApp Business app account and phone
  number". Meta's own docs note that "Coexistence" is an informal name used in
  support channels rather than the documentation's title.
- **It does not deregister the number.** The documentation states that
  "messages sent and received are mirrored between the Cloud API and WhatsApp
  Business app", that the business "can still send messages on a one-to-one
  basis using the WhatsApp Business app", and that after onboarding the app
  "will automatically refresh and indicate to the business that their number is
  now connected to the API". Nothing in the flow calls a registration or
  migration endpoint. This is the single most important verified fact: the
  ordinary phone-number migration flow, which *would* take the number off the
  app, is deliberately not used anywhere in this change.
- **Messages sent by hand from the app are visible to the API.** The
  `smb_message_echoes` webhook field delivers messages "sent via the WhatsApp
  Business app or a companion device by a business customer who has been
  onboarded to Cloud API". This is what makes a CRM timeline honest rather than
  half a conversation.
- **History sync exists but is bounded and optional.** The `history` field
  covers "all messages sent or received within 180 days" of onboarding,
  excludes group chats, and is consented to by the artist during onboarding.

Two further constraints shape the design rather than merely informing it:

- **The 24-hour customer service window.** Outside it, only an approved
  template may be sent. This CRM does not send templates, so the composer
  refuses rather than letting a reply fail at the provider.
- **The Solution Partner / Tech Provider requirement.** Meta documents that to
  use this Embedded Signup flow at all, "you must already be a Solution Partner
  or Tech Provider". There is no documented self-serve path. This is an
  external, commercial gate, and no amount of repository work removes it.

Two things could not be proven from the documentation and are therefore treated
as unknown rather than assumed: per-country eligibility for these two specific
numbers, and the exact shape of the `statuses[].errors[]` object. The webhook
consequently parses status errors defensively and stores only a stable machine
code.

## Decision

### 1. WhatsApp is an ordinary artist integration, not a parallel system

`whatsapp` joins `artist_integration_type`, and `whatsapp_message` joins
`outbox_kind`. `resolve_outbox_route` gains one mapping and nothing else. The
existing partial unique index then guarantees at most one enabled WhatsApp
integration per artist, which is what makes "no global route" a schema
property rather than a convention.

The alternative — a separate messaging subsystem with its own routing — was
rejected because it would have duplicated the parts of the outbox that are
already correct, and would have created a second place where artist routing
could be got wrong.

### 2. Artist isolation is enforced four times, independently

- **Schema.** A conversation belongs to one artist; a message carries a
  composite foreign key proving it belongs to a conversation of the same
  artist.
- **Routing.** `resolve_outbox_route` joins the outbox row's event-time artist
  to that artist's own enabled integration. A disabled Vladimir integration
  raises rather than falling through to Kristina's.
- **Credential.** Each artist's Meta phone number id, access token and app
  secret live in a separate encrypted Worker binding whose name is derived
  deterministically from that artist's non-secret integration key
  (`ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION`,
  `ARTIST_WHATSAPP_KRISTINA_HPRODUCTION`). There is no global
  `WHATSAPP_ACCESS_TOKEN` and no shared phone-number binding; the tracked
  configuration test asserts their absence.
- **Delivery.** The drain refuses a route that disagrees with its job on
  artist or integration key before any provider call.

A missing binding therefore fails closed. It never borrows the other artist's.

### 3. No provider credential is stored in the database

`integration_key` is the same non-secret selector Telegram and Calendar already
use. The existing recursive guard on `artist_integrations.configuration`
rejects credential-shaped keys and values, and the WhatsApp suite exercises it
against both a Meta access token and a nested app secret.

`phone_number_id` is deliberately treated as credential-adjacent and kept out
of the database, by direct analogy with `chat_id`, which that guard already
forbids. It is a provider destination identifier, and putting it in
CRM-readable metadata would make the browser a place where routing could be
read and eventually influenced.

### 4. The outbound path is the existing outbox, with one deliberate exception

Claim, lease, acknowledge, bounded exponential backoff and dead-lettering are
the Telegram design, including the DB-authoritative rollout watermark so that
enabling the drain later cannot replay historical rows.

The exception is the claim projection. Telegram's returns no client contact;
WhatsApp's returns the recipient and the message body, because a WhatsApp
message cannot be delivered without them. Withholding them would not have
removed the data from the system, only moved the lookup somewhere less
controlled. The boundary is preserved elsewhere instead:

- the durable outbox payload carries only `whatsapp_message_id` — the existing
  payload guard already forbids `body`, `phone` and `whatsapp` as keys;
- both values are recomputed from the authoritative conversation and message
  rows at claim time, so a mutated outbox row cannot redirect a message;
- the activity trail records neither, and the drain logs aggregate counts only.

Delivery is at least once, exactly as for Telegram. If Meta accepts a message
and the acknowledgement then fails, the lease expires and a later attempt may
resend. The Worker reports that as `unrecorded`; it does not claim the provider
call was rolled back.

### 5. The webhook is the only public surface, and it is narrow

Meta must reach it, so Cloudflare Access cannot sit in front of it. Everything
else is constrained: one path, two methods, 404 for anything else, no browser
CORS surface, a 256 KiB bounded body, JSON required, and a 503 unless
`WHATSAPP_WEBHOOK_ENABLED` is exactly `"true"`.

Authenticity is established **before** the body is parsed. Meta signs with
HMAC-SHA256 over the raw body using the app secret; the signature is compared
in constant time against the configured artist bindings, and only a binding
whose secret actually signed the delivery may then resolve an artist. Parsing
first would have let an unauthenticated caller steer routing.

The artist is then resolved by matching the payload's `phone_number_id` against
those same encrypted bindings. A payload naming an unknown business phone
number resolves to no artist and is acknowledged without reaching the database.
Nothing in a webhook body — not an `artist_id`, not an `integration_key` —
selects anything.

### 6. Coexistence deduplication is a database property

Meta echoes messages the CRM itself sent as well as messages typed in the
Business app. `whatsapp_messages` is therefore unique on
`(artist_id, provider_message_id)`, and the echo entry point returns the
existing row rather than inserting a second one. A CRM-sent message keeps its
`crm` origin when its echo arrives; a genuine Business app message is stored
with `business_app` origin so the CRM can show who actually replied.

Delivery status is monotonic, because Meta callbacks can arrive out of order
and a late `sent` must not undo a recorded `read`.

### 7. History and app state sync are acknowledged, not ingested

`history` and `smb_app_state_sync` deliveries return 200 and do nothing else.
History import needs chunked, resumable handling keyed on Meta's `progress`
field, and it carries a consent decision that belongs to the artists rather
than to this change. Acknowledging without ingesting is the honest state; a
partial import would look like a working feature.

### 8. Production is prepared and inert

Both Workers ship disabled twice over: the tracked Wrangler configuration sets
the enable flag to `"false"` and declares no cron and no route, and each Worker
independently refuses to act unless its flag is exactly `"true"`. Activation
runs through a guarded workflow requiring an approved release branch, the exact
approved SHA, a protected-environment repository variable, an exact approval
phrase, and a pre-provisioned exact secret-name set. That workflow never writes
a secret, never contacts Meta and never sends a message.

## Security boundaries

- Browser, GPT and webhook input can select none of: artist, provider account,
  phone number id, integration key, access token, credential binding, or
  destination phone number.
- The CRM send RPC takes a conversation the CRM already owns, resolves the
  artist from the stored row, and requires `manage` capability on that artist.
  Read-only members, deactivated profiles and inactive memberships are all
  refused, and each is asserted by a denial test.
- The claim, acknowledgement and ingestion RPCs are `service_role` only;
  `anon` and `authenticated` are refused. The CRM send RPC is `authenticated`
  only; `service_role` cannot use it.
- The Worker Supabase allow-list gains exactly the six required RPCs.
- No Meta token, app secret or phone number id appears in the database, in
  browser-visible configuration, in logs, in outbox payloads, in the activity
  trail, or in any test fixture.

## Out of scope

This ADR does not authorise, and this change does not perform:

- becoming a Meta Solution Partner or Tech Provider, or any App Review;
- creating a Meta app, WhatsApp Business Account or system user token;
- running Embedded Signup, or any coexistence onboarding step;
- registering, migrating or deregistering either phone number;
- enabling Meta billing or accepting any cost;
- deploying either Worker, creating a route, or enabling a cron;
- sending or receiving a single real WhatsApp message;
- message templates, marketing consent, or any automated outbound sequence;
- a GPT-facing WhatsApp send action.

Marketing consent remains distinct from a client's WhatsApp contact preference.
`preferred_contact = 'WhatsApp'` means the client prefers to be answered there.
It is not consent to be messaged first, and nothing in this change treats it as
such.
