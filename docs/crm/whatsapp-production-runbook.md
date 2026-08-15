# WhatsApp production activation runbook

Nothing in this repository has contacted Meta. No Meta app, WhatsApp Business
Account, phone number, credential, route or cron exists for this integration.
This document describes what activation would involve, in order, so that the
external steps are visible before anyone starts.

Read `docs/crm/adr/0007-whatsapp-coexistence-and-artist-isolation.md` first.

## What coexistence does and does not synchronise

Verified against current official Meta documentation.

**It does:**

- keep both artists on the WhatsApp Business app, on the same numbers — no
  step in the `whatsapp_business_app_onboarding` flow deregisters or migrates a
  number;
- mirror messages between the app and the Cloud API in both directions;
- deliver messages the artist sends **by hand from the app** to the webhook, as
  `smb_message_echoes`, so the CRM timeline is not half a conversation;
- deliver inbound client messages and `sent`/`delivered`/`read`/`failed`
  status callbacks.

**It does not:**

- import historical chats automatically. The `history` field can deliver up to
  **180 days** of prior messages, but only if the artist consents during
  onboarding, it excludes group chats, and media asset ids arrive only for
  media sent within 14 days of onboarding. **This CRM acknowledges `history`
  deliveries and deliberately does not ingest them yet.**
- cover group chats at all — groups are unavailable for these numbers, and are
  excluded from history sync;
- mirror messages sent from an *unsupported* companion client;
- allow a free-form reply more than 24 hours after the client's last message.
  Outside that window Meta requires an approved template, which this CRM does
  not send. The composer refuses instead of failing at the provider.

Two things could not be established from documentation and must be confirmed by
attempting the flow: per-country eligibility for these two specific numbers,
and whether a payment method must be attached before inbound messages are
delivered.

## Blocking external prerequisite

Meta documents that this Embedded Signup flow requires the connecting app to
**already be a Solution Partner or Tech Provider**. There is no documented
self-serve path for a business connecting its own number.

That means one of:

1. complete Meta business verification and App Review for a Vishar Meta app,
   with Advanced access to `whatsapp_business_messaging` and
   `whatsapp_business_management`; or
2. onboard through an existing Business Solution Provider that already supports
   coexistence, and point this integration at the credentials it issues.

For a two-artist studio, option 2 is usually cheaper and faster. This is a
commercial decision, not an engineering one, and nothing in the repository can
remove it.

## Order of operations

Each step is separately authorised. Do not batch them.

1. **Resolve the Tech Provider / BSP question above.** Everything else is
   blocked on it.
2. **Meta app and WABA.** Create the app, complete verification, and obtain the
   app secret. No repository change.
3. **Coexistence onboarding, once per artist.** This needs the artist present
   with their phone: they enter their number, open the WhatsApp Business app,
   tap **Connect to the Business Platform**, choose whether to share chat
   history, and paste the verification code. There is no QR scan in the
   documented flow. Record the resulting `phone_number_id` and WABA id.
4. **Subscribe the webhook fields**: `messages`, `smb_message_echoes`,
   `history`, `smb_app_state_sync`.
5. **Provision Worker secrets** — names only ever appear in this repository,
   never values:
   - `SUPABASE_SECRET_KEY`
   - `WHATSAPP_VERIFY_TOKEN` (webhook Worker only)
   - `ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION`
   - `ARTIST_WHATSAPP_KRISTINA_HPRODUCTION`

   Each `ARTIST_*` value is a JSON envelope for that artist alone:
   `{"phoneNumberId": "…", "wabaId": "…", "accessToken": "…", "appSecret": "…"}`.
   Never put both artists in one envelope, and never create a global binding.
6. **Enable the two `artist_integrations` rows** through the existing owner
   RPC, with `integration_type = 'whatsapp'`, `provider = 'meta_cloud_api'` and
   integration keys `vladimir-production` / `kristina-production`. Store no
   credential in `configuration`; the database guard rejects it anyway.
7. **Deploy the webhook Worker** and add its route, then complete Meta's
   verification handshake. Until `WHATSAPP_WEBHOOK_ENABLED` is `"true"` it
   answers 503 to everything, so deploying it is safe on its own.
8. **Confirm inbound works** with one real message from a phone the studio
   controls, and check it appears in the CRM against the right artist.
9. **Only then activate outbound**, via
   `deploy-private-production-whatsapp.yml` with
   `CRM_PRODUCTION_WHATSAPP_DEPLOY_ENABLED=true` and the approval phrase
   `ENABLE_PRIVATE_CRM_WHATSAPP_DRAIN`.

## Verify immediately after each activation

- an inbound message from Vladimir's number creates a conversation owned by
  Vladimir, and Kristina's members cannot see it;
- a message the artist sends by hand from the Business app appears in the CRM
  labelled **Sent from WhatsApp app**, not as a CRM send;
- a CRM send appears once, not twice, when its echo arrives;
- delivery state advances `sent` → `delivered` → `read` and never goes
  backwards;
- a message to a number with no configured binding fails closed;
- no log line, activity row or outbox payload contains a phone number, message
  body or provider token.

## Rollback

Set the enable flag to `"false"` and redeploy, or remove the webhook route. The
artists keep using the WhatsApp Business app throughout: the integration is
additive, and disabling it does not take a number away from a phone.
