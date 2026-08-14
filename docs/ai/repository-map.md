# Vishar-site repository map for engineering agents

Use this as a search map, not as an architectural authority. Confirm every path and symbol at the exact ref under investigation.

## Public site and booking surface

Primary public static assets live at the repository root and in public page directories such as `booking/`.

The production-compatible Cloudflare Worker entry point is `workers/tattooai.js`. Staging and preview behavior may use separate entry points such as `workers/preview.js`. Do not assume preview configuration matches production.

The durable booking intake orchestration is in:

- `workers/routes/enquiries.js`
- `workers/lib/http.js`
- `workers/lib/validation.js`
- `workers/lib/supabase.js`
- `workers/lib/storage.js`
- `workers/lib/provider-routing.js`
- `workers/lib/telegram.js`

A useful booking trace usually begins in `handleEnquiryIntake` and then follows the exact RPC names passed through the narrow Supabase client.

## Trusted database boundary

Database schema and behavior live in `supabase/migrations/`. Treat migrations as an ordered history, not as independent files. A function first introduced in one migration may be replaced, hardened, re-granted, or constrained later.

Current functional milestones in the active CRM stack include:

- `0001`-`0014`: CRM foundation, RLS, Storage, activity/outbox, retention, ACL hardening, and private finance sources.
- `0015`-`0025`: artists, artist-scoped records and RLS, trusted booking sources, integrations, payments, artist workflow RPCs, activity ownership history, and backend-only artist outbox routing.
- `0026`-`0031`: appointment types, consultation bounds, Google Calendar projection, Calendar outbox drain, connection status, and five-minute appointment grid.
- `0032`-`0034`: GPT appointment actions and OAuth/consent hardening.

For a database symbol, search all later migrations after finding its first definition.

## Private CRM

The private CRM application is under `admin/`. Its browser access is constrained by Supabase Auth/RLS and application role logic. Cloudflare Access is defence in depth for hosted environments, not a replacement for database authorization.

When a CRM action calls an RPC, trace both the UI caller and the exact SQL function, then verify role checks, grants, RLS implications, and tests.

## Artist and provider routing

The main server-side routing components are:

- `workers/lib/provider-routing.js`
- `supabase/migrations/0017_booking_sources_integrations.sql`
- `supabase/migrations/0025_artist_outbox_routes.sql`

The intended boundary is:

```text
browser request
  -> exact Origin validation
  -> server-configured booking source and form version
  -> trusted booking-source resolution in Postgres
  -> artist-owned enquiry/outbox row
  -> backend-only safe route metadata
  -> encrypted provider credential selected by Worker binding/KV
  -> external provider
```

Browser multipart data must never be treated as authoritative for `artist_id`, integration key, provider account, Telegram destination, payment destination, or OAuth credential selection.

## Calendar

Calendar-related implementation is spread across SQL, the canonical Worker, a dedicated OAuth surface, and provider modules. Search at least:

- `supabase/migrations/0028_calendar_projection_foundation.sql`
- `supabase/migrations/0029_calendar_outbox_drain.sql`
- `supabase/migrations/0030_calendar_connection_status.sql`
- `workers/lib/calendar-drain.js`
- `workers/lib/calendar.js`
- `workers/lib/google-calendar.js`
- `workers/calendar-oauth.js`
- `workers/lib/calendar-oauth-security.js`
- `docs/crm/adr/0003-google-calendar-projection-and-artist-routing.md`
- `docs/crm/adr/0004-google-calendar-oauth-and-token-custody.md`

Do not infer a complete Calendar flow from one Worker file. Versioning, lease ownership, retry/dead-letter behavior, token custody, and provider calls cross several layers.

## GPT / agent-facing appointment actions

Search:

- `workers/gpt-actions.js`
- `workers/gpt-actions-staging.js`
- `workers/lib/gpt-actions.js`
- `workers/lib/ai-tools.js`
- `supabase/migrations/0032_gpt_appointment_actions.sql`
- `supabase/migrations/0033_gpt_appointment_actions_hardening.sql`
- `supabase/migrations/0034_gpt_oauth_consent_guard.sql`

Never infer that an external GPT/OAuth client is active merely because the code exists. Check the exact environment and deployment evidence separately.

## Tests and CI

Search `tests/`, `supabase/tests/`, and `.github/workflows/` alongside the implementation. For SQL behavior, pgTAP coverage is part of the evidence. For Worker changes, include Worker unit/contract tests. For CRM changes, include the private CRM test/typecheck/build path.

A green workflow from an older SHA is not evidence for the current head.

## Existing durable documentation

The detailed CRM documentation remains under `docs/crm/`, including:

- `ARCHITECTURE.md`
- `SECURITY.md`
- `INTEGRATIONS.md`
- `DEPLOYMENT.md`
- `README.md`
- `adr/`

These documents provide intent and historical decisions. Verify current behavior in code before relying on them.

## Fast search examples

```bash
rg -n "create_trusted_enquiry_intake|finalize_enquiry_intake|resolve_outbox_route" workers supabase tests docs
rg -n "reschedule_appointment|claim_calendar_outbox|record_calendar_outbox_result" workers supabase tests docs
rg -n "grant execute|revoke all|security definer" supabase/migrations
```

Use the helper scripts in `scripts/ai/` for repeatable read-only searches.