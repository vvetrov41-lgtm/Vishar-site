# Vladimir existing WhatsApp provisioning

## Goal

Connect Vladimir's existing production WhatsApp Business account to Vishar CRM through the Meta Cloud API without Facebook Login for Business / Embedded Signup and without exposing the persistent Meta System User token outside the authenticated CRM-to-provider boundary.

## Fixed production identity

- Artist ID: `a1111111-1111-4111-8111-111111111111`
- Integration key: `vladimir-production`
- Meta App ID: `1481226093843982`
- WABA ID: `341184815737145`
- Phone Number ID: `328102027058293`
- Worker secret binding: `ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION`
- Drain Worker: `vishar-whatsapp-drain-production`
- Webhook Worker: `vishar-whatsapp-webhook-production`

The empty WABA `1592526142577092`, Kristina WABA `462106700328578`, Test WABA `1777089050389580`, and every other artist are outside this release scope.

## User flow

1. An authenticated CRM operator who can manage Vladimir's integrations opens the WhatsApp integration page.
2. The operator pastes a Meta System User token into a password input on `crm.vishartattoo.com`.
3. The browser sends the token only to the same-origin authenticated endpoint `POST /api/whatsapp/existing-account/provision` over HTTPS.
4. The field is cleared after the attempt and the token is never persisted by the browser application.
5. The backend validates the token and fixed Vladimir Meta identity before any Cloudflare secret mutation.
6. Only after all readbacks succeed does the backend mark the CRM integration connected.

## Security requirements

The System User token must never be stored in Supabase/Postgres, returned in an HTTP response, written to application logs, exposed through GPT/MCP, copied through chat, or rendered again after submission.

The backend must fail closed on all mismatches and must validate, in order:

1. authenticated CRM operator and Vladimir integration-management capability;
2. exact prepared CRM route with provider `meta_cloud_api`, integration key `vladimir-production`, enabled state, and empty safe configuration;
3. `debug_token` with `is_valid = true`;
4. exact App ID `1481226093843982`;
5. scopes `whatsapp_business_management` and `whatsapp_business_messaging`;
6. exact WABA `341184815737145`;
7. exact Phone Number ID `328102027058293` is returned by that WABA's `phone_numbers` collection.

No Cloudflare write may happen before all Meta identity validation has passed.

## Provisioning mutation and readback

After validation the backend writes the existing credential envelope `{ phoneNumberId, accessToken, wabaId, appSecret }` to Vladimir's exact secret name in both production WhatsApp Workers, then subscribes the WABA to the Vishar CRM app.

Before CRM connected state is changed, the backend must read back:

- exact WABA and Phone Number ID membership from Meta;
- `subscribed_apps` containing exact App ID `1481226093843982`;
- Cloudflare secret inventory showing Vladimir's exact secret name on drain Worker;
- Cloudflare secret inventory showing Vladimir's exact secret name on webhook Worker.

The backend then updates only `artist_integrations.connected_at` through the authenticated operator's existing Supabase authorization boundary and verifies the returned row. `configuration` remains `{}`.

Partial provider mutations must never be represented as a connected CRM integration. A retry may safely overwrite the same fixed Worker secret names and repeat the WABA subscription.

## Product scope

Direct existing-account provisioning is Vladimir-only in this release. Kristina remains outside this direct path on both client and server. No new WABA, WhatsApp number, Facebook/Instagram connection, app publishing, Tech Provider verification, production database migration, or drain activation is part of this workstream.

The drain Worker must remain inert with `WHATSAPP_DRAIN_ENABLED=false` and no cron until a separately approved activation workstream.

## Operator parity

This capability is `ui_only`. The persistent Meta System User token is a provider credential that must be entered by the authorized human directly into the CRM over HTTPS. GPT/MCP must not accept, relay, store, or operate on this token.

## Acceptance

The workstream is accepted only after:

`code -> exact-head CI -> merge -> exact-head post-merge CI -> guarded CRM production deploy -> production readback -> human Meta System User token generation -> CRM provisioning -> Meta/WABA/Cloudflare readback -> connected_at verified in production`
