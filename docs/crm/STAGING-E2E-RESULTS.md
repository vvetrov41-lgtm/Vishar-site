# Hosted staging E2E results

Date: 2 August 2026

Scope: PR #176 hosted staging only. Production was not changed.

## Application and isolation

- Approved booking and CRM application SHA: `2961452472d099aab75ca3522a7a2f8c3615e360`
- Preview-origin fix SHA: `479fc6c71de06f04e100d15cdb9c1769d33b4a2e`
- Booking Pages: `vishar-booking-staging`
- CRM Pages: `vishar-crm-staging`
- Preview Worker: `tattooai-preview`
- Worker custom domain: `intake-staging.vishartattoo.com`
- `workers.dev` disabled for preview
- Exact intake path: `/__vishar-staging-intake-2026`
- Booking and CRM Pages protected by owner-only Cloudflare Access
- Worker endpoint intentionally not protected by Access

## Passed checks

- Anonymous booking and CRM access reaches Cloudflare Access.
- Owner authentication opens the booking preview and CRM.
- Allowed-origin OPTIONS returns `204` with the exact staging origin, `POST, OPTIONS`, and `Content-Type`.
- Invalid-origin OPTIONS returns `403`, no `Access-Control-Allow-Origin`, and safe code `origin_not_allowed`.
- Valid multipart synthetic intake returns `200`.
- Browser intake creates the expected client, enquiry, manifest, private Storage object, outbox job, and activity events.
- Telegram notification reaches only the `Vishar CRM Staging` destination.
- Reusing the same idempotency key returns `ENQ-2026-0002` with `replayed=true` and creates no duplicate.
- Rate-limit burst returns five `204` responses followed by two `429` responses; a request after 12 seconds returns `204`.
- GET and disallowed paths or methods are blocked by the hostname-scoped WAF rule.
- CRM owner can view the enquiry and its short-lived private image link.
- Enquiry status transition, follow-up creation, and conversion to one project succeed.
- The resulting project is `draft` with currency `GBP`.
- Accidental non-synthetic `ENQ-2026-0003` data and its Storage object were removed after explicit owner approval; detached audit events were retained.

## Retained synthetic state

- clients: 1
- enquiries: 1 (`ENQ-2026-0002`, `converted`)
- projects: 1 (`draft`, `GBP`)
- enquiry file manifests: 1
- private Storage objects: 1
- outbox rows: 1 (`succeeded`)

## Safety state

- Production files, keys, URLs, Supabase project, Telegram destination, DNS, and Worker deployment were not changed.
- PR #174 and PR #176 remain draft, open, and unmerged.
- Staging resources remain active pending a separate teardown decision.
