# ADR 0007: a provider-neutral communications domain with channel adapters

Status: proposed, code prepared and validated, no production runtime deployed

## Context

Adding Instagram Professional messaging to the CRM had an obvious cheap path:
copy the WhatsApp stack. WhatsApp already had `whatsapp_conversations`,
`whatsapp_messages`, a `whatsapp_message` outbox kind, a claim/lease/ack RPC
trio and a dedicated drain Worker. Duplicating those for Instagram would have
been mechanical.

It would also have been the wrong shape. The hard parts of messaging in this
CRM are not provider wire formats — they are artist ownership, idempotent
ingestion, delivery-state monotonicity, conservative client linking and the
rule that no browser or webhook body may choose an artist. Two copies means two
places for those rules to drift, and a security fix applied to one and not the
other.

## Decision

There is one communications domain, and channels attach to it as adapters.

```text
communication_conversations      artist, channel, external participant
  -> communication_messages      normalised inbound/outbound history
     -> integration_outbox       the existing durable queue, one kind per channel
        -> provider adapter      WhatsApp (Meta Cloud API) | Instagram (Instagram Login)
```

The core owns artist ownership, participant identity, link state, message
normalisation, delivery-state transitions, the claim/lease/retry engine and CRM
authorisation. An adapter owns exactly one provider's webhook format,
identifiers, API requests, error mapping and credential custody.

### Identity is channel-neutral

WhatsApp's `contact_wa_id` is a phone number. Instagram has no phone number at
all: a participant is an Instagram-scoped id that is meaningful only inside one
professional account. A phone number is therefore not a domain identity, and
`external_contact_id` is the provider's participant identifier for the channel,
with a channel-aware shape constraint rather than a lowest-common-denominator
one.

### Message bodies are nullable

`communication_messages.body` is nullable and has no default. An Instagram
share, story reply, reaction or unsupported message legitimately has no text. A
`not null` body would have forced either a fabricated placeholder or a second
table later.

### Attachments are recorded as shape, not content

Meta serves Instagram media from short-lived signed CDN URLs. Persisting one
would put an expiring, credential-like value into a browser-readable table for
no lasting benefit, because it cannot be re-fetched once it expires.
`attachments` therefore holds the ordered attachment types only, and
`media_state` reserves a future ingestion lifecycle without blocking it. This
release only ever writes `not_ingested`.

## WhatsApp compatibility

Production WhatsApp was live when this work started, so the transition is
conservative rather than clean-slate:

* Rows keep their primary keys, so an existing outbox job still points at the
  same message and a CRM deep link still resolves.
* `public.whatsapp_conversations` and `public.whatsapp_messages` are
  republished as `security_invoker` views with the same column names and the
  same enum types. The deployed CRM, the production GPT read RPCs from
  migration 0054 and any other reader keep working against the same names,
  under the same row level security. Both views are read-only by an explicit
  `INSTEAD OF` trigger, so the compatibility layer cannot become a second write
  path into the core.
* Every WhatsApp RPC keeps its exact name, argument list, return shape and
  grant, including the column names in the claim projection that the deployed
  drain Worker validates. The already-deployed WhatsApp Workers therefore do
  not need a redeploy for this migration to be safe.

`scripts/test-communications-migration.sh` proves this rather than asserting
it: it replays the migration history in stages against a throwaway database,
seeds production-shaped WhatsApp rows including a queued job, applies the
communications migrations and then checks that every record, link and RPC
signature survived.

## Cloudflare topology

Instagram gets its own Worker, `vishar-instagram-production`, rather than an
adapter inside the live WhatsApp webhook Worker.

The reasons are specific rather than aesthetic:

* `vishar-whatsapp-webhook-production` is already serving Meta callbacks for a
  production account on `whatsapp.vishartattoo.com`. Adding an OAuth surface,
  two KV namespaces and a token encryption key to it would force a redeploy of
  a live public Meta callback for a feature it does not need.
* Instagram Login issues refreshable long-lived *user* access tokens. WhatsApp
  uses static per-artist envelopes. Keeping the refreshable token store
  isolated from the WhatsApp app-secret store limits what a single Worker
  compromise yields.
* The connector's shape already exists in this repository: the Gmail and Monzo
  Workers are the established "OAuth connector Worker" pattern — dedicated KV
  state and token namespaces, a dedicated encryption key, a rate limiter and a
  Custom Domain.
* The channel-neutral half of the engine lives in Postgres, so a second Worker
  is a second adapter, not a second engine.

The tracked Wrangler config is inert: no cron, no KV binding, every capability
off. The guarded release generates the active configuration and refuses to
enable the outbound drain before onboarding, because a queue that cannot obtain
a token is not a useful state to deploy into.

## Instagram authentication

The implemented contract is Meta's Instagram API with Instagram Login. Two of
its properties drove the design:

* The account identity that arrives on a webhook (`entry[].id`) is only learned
  at connection time through OAuth, so it cannot be a static Worker variable
  the way a WhatsApp phone number id is. The mapping from that id to a CRM
  artist lives in `artist_integrations.configuration`, is written only by the
  connector after server-side verification, is unique across artists, and fails
  closed for an unknown account.
* One Meta app serves both artists, so the webhook signature proves only that
  Meta sent the payload — never which artist it belongs to. Artist resolution
  is a separate backend-owned lookup. This is the boundary that stops one
  artist's account from opening the other artist's conversation, and it is the
  one place where this design differs materially from the WhatsApp webhook,
  where each route carries its own app secret.

Instagram Business Login does not document PKCE. The CSRF and binding control
is therefore a single-use, short-lived KV state entry created only after the
database has confirmed that the initiating CRM operator may manage that
artist's integrations, and carrying the artist and selector the database
returned rather than anything the browser supplied.

## An inbound message is not an enquiry

Instagram traffic includes greetings, reactions, spam and ordinary chat with
existing clients. Automatically minting a tattoo enquiry from every direct
message would fill the pipeline with noise and destroy the meaning of the
enquiry funnel.

An unknown sender therefore arrives as an `unmatched` conversation and stays
that way until an operator links a client, creates one, or promotes the
conversation to an enquiry. The only identifier trusted to link automatically
is the provider participant id, which is why a returning sender lands back in
their existing conversation with its existing client link. Handle or name
similarity is a suggestion in the interface and is never applied as an
authoritative action.

Promotion reuses `create_manual_enquiry` rather than reimplementing client
matching, reference numbering, idempotency and privacy rules. That means an
email address is required, because intake requires one — the CRM asks the
operator for it instead of inventing a synthetic address.

## Attribution

Provider referral and ad context is stored on the conversation, written only by
the trusted webhook ingestion path, and an enquiry created from a conversation
carries typed provenance columns plus a foreign key back to it. Attribution is
therefore something the provider asserted inside a signed payload, never
something a browser can claim, and the
ad → DM → conversation → enquiry → project funnel stays joinable without
building a separate analytics store now.

## Gmail

Gmail keeps its own thread-oriented model. Its message content lives in Gmail
and is fetched on demand; only thread context is stored, in `crm_private`.
Copying it into the communications tables would duplicate mail the CRM does not
own, for no capability the inbox needs. The inbox says so explicitly rather
than showing an empty Email tab that looks broken.

## Delivery semantics

Delivery is at least once, not exactly once, for the same reason as ADR 0005: a
provider can accept a message before the Worker loses connectivity to Supabase.
The drain reports that state as `unrecorded` rather than claiming the provider
call was rolled back.

Instagram publishes a read watermark (`messaging_seen`) rather than per-message
delivery receipts, so the adapter applies `read` to the outbound messages the
watermark covers and never claims `delivered`, which Meta does not report for
this channel.

Meta's 24 hour messaging window is surfaced as its own explicit error state
(`instagram_outside_messaging_window`) rather than retried into a wall or
worked around with the human agent tag, which would be a different consent and
billing story.

## Consequences

* One security surface to review instead of two, at the cost of one migration
  that moves live production rows.
* A future channel is an adapter plus one enum label, not a schema.
* The compatibility views and wrappers are debt with a clear retirement path:
  once the CRM, the GPT surface and the WhatsApp Workers all address the neutral
  names, the WhatsApp-specific projections can be dropped in a later migration.
* A later unified GPT can consume `list_communication_conversations`, the
  conversation read surface and `queue_communication_message` without a
  channel-specific API. Nothing is exposed to GPT in this release.
