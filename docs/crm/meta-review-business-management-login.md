# Meta App Review: isolated `business_management` login

## Purpose and current state

The existing `whatsapp_business_management` template controls and the
`business_management` read-only review-WABA lookup are **not** user consent.
The production Coexistence configuration `3104916749850885` and general
configuration `4468652066715473` must stay unchanged.

This flow is for a real Meta Login for Business consent on an **isolated
non-production business portfolio**, followed by a read-only lookup of that
same business with the resulting short-lived user token. A new configuration
is **not created by this code**; it must exist in the Meta Developer dashboard.
Do not invent a configuration ID.

## Meta dashboard setup (before enabling)

1. Open app `1481226093843982` in Meta for Developers.
2. Facebook Login for Business → Configurations → create a **new** General
   login configuration using **User access token**. Select
   `business_management`; add only dependencies Meta explicitly requires.
   Do **not** choose WhatsApp Embedded Signup or Coexistence.
3. On Facebook Login for Business settings, add this exact Valid OAuth Redirect
   URI without removing the existing redirect:
   `https://app.vishartattoo.com/?meta_business_review=1`.
4. Create or select a legitimately controlled test business portfolio whose
   Meta ID differs from the production Vishar Tattoo Limited business
   (`692776505711216`). Ensure the Meta user recording the demo is an app
   tester/admin and has access to that test portfolio. Do not use Kristina's
   business, phone, production WABA, or the live Vladimir connection.
5. Record the new configuration ID and test business ID. No secret/token
   is copied into code or user messages.

## Disabled-by-default production configuration

Only after the Meta configuration exists and the protected release
mechanism supports the three **exact** new Pages binding names:

- `META_REVIEW_BUSINESS_LOGIN_ENABLED=true` (plain text; off/absent by default)
- `META_REVIEW_BUSINESS_CONFIG_ID=<new General config ID>`
- `META_REVIEW_BUSINESS_ID=<isolated test business ID>`

Apply bindings **only** to `vishar-crm-production` through an approved,
fail-closed configuration change. The existing `META_APP_SECRET` is
reused server-side without exposing it. Do not change
`vishar-crm-internal` secret bindings, production WhatsApp bindings,
routing or Coexistence. Cloudflare's protected release gate currently
requires exact binding-name equality; update its expected list together
with the actual bindings, not earlier or by bypassing the gate.

## Flow and security

1. CRM owner opens `https://app.vishartattoo.com/#/integrations/whatsapp`
   → Meta App Review → **Log in with Meta (test business)**.
2. Operator CRM requests only the server-configured config ID from the
   owner-guarded endpoint `/api/whatsapp/meta-review/business-login`.
3. The browser creates a 256-bit single-use CSRF state with a 10-minute
   expiry in operator-origin sessionStorage. It navigates to Meta's
   `/dialog/oauth` with the separate config ID and the exact operator
   redirect URI. On iPhone/iPad it uses `m.facebook.com` with `display=touch`
   to reduce native Facebook app interception; desktop keeps `www.facebook.com`.
   No WhatsApp `extras`, embedded-signup feature, phone-number ID or WABA ID
   is sent. If iOS still switches to the Facebook app, returning to the CRM
   tab restores the login button and displays a browser-retry instruction,
   without claiming consent was granted.
4. After Meta consent, the operator origin consumes the matching callback,
   erases the OAuth code and state from the address bar, and exchanges the
   code **once** through the owner-guarded Pages Function.
5. Server exchanges the authorization code using its existing app secret,
   checks that `business_management` is granted, reads `/me/businesses`,
   matches only `META_REVIEW_BUSINESS_ID`, and returns only that business
   name/ID to CRM. User tokens are never persisted or returned.
6. No CRM write, WhatsApp subscription, Worker binding update, phone
   registration, or message is possible through this route.

A failed or ambiguous OAuth exchange must be restarted by the owner rather
than retried automatically. This flow does not prove Meta's actual test
configuration exists or that Meta will approve the permission.

## Review-video acceptance criteria

The recording must show: the real CRM, a real Login for Business permission
grant, selection/consent of the isolated business where Meta offers this,
return to CRM and the business name/ID with `business_management: granted`.
Set the CRM/Meta UI to English if possible. Do not show account passwords,
tokens or private customer data.

Meta may require more substantive evidence of business-asset management
depending on the live App Review wording. Confirm that the permission is
actually required for the CRM's product use case; never submit an artificial
workflow solely to claim access to unrelated business assets.
