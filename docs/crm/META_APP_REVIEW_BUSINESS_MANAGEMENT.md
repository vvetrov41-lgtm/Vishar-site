# business_management review demonstration

## Purpose

The existing Meta App Review template panel demonstrates
`whatsapp_business_management`, not `business_management`. The latter needs
evidence that Vishar CRM identifies an authorized business and its WhatsApp
account. The production Coexistence button is not a review tool: it starts the
real onboarding of Kristina's WhatsApp Business App number.

## Read-only review path

The owner opens **More → Integrations → WhatsApp → Meta App Review** and selects
**Check review business**. The CRM calls its same-origin Pages Function with
the owner's Supabase session token. The function verifies the active owner
profile, the exact production and operator origins, the enabled review binding,
and the server-fixed review WABA. It uses the server-side Meta token for a GET
to `/{business-id}/owned_whatsapp_business_accounts` and returns only the
server-fixed WABA if Meta lists it under Vishar Tattoo Limited. The UI displays
the business ID, WABA ID and name. No browser-selected IDs, Meta tokens,
customer data, production route or phone registration enter this request.

If the review WABA is not owned by business `692776505711216`, or the token
lacks `business_management`, the call fails closed. In that case, use a
separate authorized test business and explicitly configured server bindings;
do not substitute Kristina's or Vladimir's live WABA. The first 100 owned
WABAs are checked, so a larger portfolio needs bounded pagination before use.

## Recording, once the production readback succeeds

1. On iPhone, start screen recording before opening the CRM. Keep credentials
   and tokens out of the video.
2. Open `https://crm.vishartattoo.com/` as the owner, then **More → Integrations
   → WhatsApp → Meta App Review**.
3. Show the notice that this is a read-only review path. Tap **Check review
   business**. Wait for Meta readback to show the business ID and review WABA.
4. Show the same business and review WABA in Meta Business Settings if the
   account UI permits it, then stop. Do not tap Kristina's Coexistence button,
   upload a token, register a phone or change Vladimir's working route.
5. Send the recording for inspection. Replace only the `business_management`
   attachment in the existing App Review submission. The template recording
   remains with `whatsapp_business_management`.

This demonstrates a real business asset read via `business_management`. It does
not claim to show an Embedded Signup authorization event. The permission
narrative and reviewer instructions must describe the demonstrated use
accurately. Meta may still ask for a full Embedded Signup flow; if so, build an
isolated test onboarding with no production callback or artist binding before
recording it.
