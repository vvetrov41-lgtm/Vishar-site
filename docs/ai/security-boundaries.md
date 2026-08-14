# Security boundaries for engineering investigations

This file is a mandatory checklist for code investigation. It is not proof that a control exists at a particular ref. Verify every applicable boundary in the current implementation, migrations, grants, policies, tests, and deployment configuration.

## 1. Public browser is untrusted

Treat all browser form fields, query parameters, headers other than server-observed transport facts, and client-generated identifiers as attacker-controlled until validated.

For booking intake, verify:

- exact `Origin` enforcement happens before persistence;
- request/body/file limits are server-side;
- multipart fields cannot select `artist_id`;
- multipart fields cannot select a booking-source key or form version used as authoritative routing input;
- multipart fields cannot select an integration key, provider account, Telegram destination, payment destination, Calendar account, or OAuth credential;
- idempotency is enforced by an authoritative backend boundary, not only by a disabled browser button.

Current search anchors include `handleEnquiryIntake`, `isAllowedOriginFor`, and `readTrustedBookingConfig`.

## 2. Trusted booking-source resolution

The server-controlled tuple is conceptually:

```text
source key + exact observed Origin + deployed form version
```

Trace that tuple from Worker environment/configuration to the database resolver and then to the artist-owned enquiry. Verify the active `booking_sources` row and the backend-only resolver behavior at the target ref.

Search at least:

- `workers/lib/provider-routing.js`
- `workers/routes/enquiries.js`
- `supabase/migrations/0017_booking_sources_integrations.sql`
- every later migration containing `booking_sources`, `resolve_booking_source`, or `create_trusted_enquiry_intake`.

Do not accept a documentation statement that browser routing is impossible without checking the actual function signature and caller payload.

## 3. Privileged Supabase credential boundary

The public Worker carries a privileged Supabase backend credential, so its callable database surface must stay narrow.

Verify:

- `workers/lib/supabase.js` exposes only an explicit RPC allow-list;
- no generic table/query/arbitrary SQL path has been introduced;
- backend URL validation fails closed before a credential is sent to an unexpected origin;
- keys are never logged or returned;
- each allow-listed RPC has the intended database grants and internal authorization checks.

For each privileged RPC, inspect both the JavaScript allow-list and SQL `GRANT`/`REVOKE` history.

## 4. CRM authorization boundary

Cloudflare Access can protect a hosted CRM URL, but database authorization must remain authoritative.

For CRM reads/writes verify as applicable:

- Supabase Auth identity;
- active profile checks;
- owner/manager/read-only role behavior;
- artist membership/scope;
- RLS policies;
- RPC role checks;
- column/table grants;
- no privileged browser credential;
- tests for denied roles and cross-artist access.

Do not infer authorization from hidden UI controls.

## 5. Provider routing and secret custody

The database may contain provider-neutral safe routing metadata, but provider credentials must remain outside browser-visible and CRM-readable data.

Trace:

```text
outbox row
  -> event-time artist
  -> outbox kind
  -> backend-only resolve_outbox_route
  -> safe integration metadata
  -> Worker-side binding/KV lookup
  -> provider credential
```

Verify `resolve_outbox_route` remains backend-only and returns no payload, client data, token, chat ID, refresh token, private key, or other credential.

Verify `artist_integrations.configuration` is still guarded against credential-shaped keys/values if that table is involved.

Current anchors:

- `supabase/migrations/0017_booking_sources_integrations.sql`
- `supabase/migrations/0025_artist_outbox_routes.sql`
- `workers/lib/provider-routing.js`

## 6. Outbox durability boundary

External provider delivery must not decide whether an already durable booking exists.

For enquiry intake verify the order:

1. validation;
2. durable intake creation;
3. private file upload/manifest acknowledgement;
4. finalization;
5. outbox/provider notification.

A Telegram or other notification failure after finalization must not convert a saved enquiry into a failed submission.

Trace `record_outbox_attempt` and any later drain/retry logic before claiming delivery semantics.

## 7. Google Calendar boundary

Supabase appointments remain authoritative. Google Calendar is a projection.

Verify:

- authorized appointment mutation happens before queueing;
- `calendar_version` advances atomically with the mutation;
- outbox jobs contain the minimum safe projection;
- leasing is backend-only;
- overlapping drains use `FOR UPDATE ... SKIP LOCKED` or equivalent current protection;
- lease ownership is checked on acknowledgement;
- stale provider results cannot overwrite a newer appointment version;
- bounded retries/dead-letter behavior is preserved;
- refresh tokens and encryption material do not enter Supabase or browser data.

Current anchors include migrations `0028` and `0029`, `workers/lib/calendar-drain.js`, `workers/lib/google-calendar.js`, and the Calendar OAuth ADRs.

## 8. OAuth and GPT action boundary

Code presence does not prove external activation.

For Calendar or GPT OAuth/action work, separately verify:

- exact redirect URI handling;
- PKCE/state/nonce or the currently specified anti-CSRF controls;
- client-to-artist binding;
- token custody and encryption;
- scopes;
- consent gates;
- account identity checks;
- disabled/inactive configuration in environments where activation is out of scope;
- no wildcard redirect or guessed callback URI;
- no production enablement inferred from staging code.

Search later hardening migrations after the first GPT/OAuth implementation.

## 9. Storage boundary

For private client images verify:

- content and size validation;
- server-controlled object paths;
- private bucket/policies;
- object-to-manifest ownership;
- signed/private read path where applicable;
- compensation does not delete an object whose database acknowledgement may already have committed;
- no public URL or browser-held service credential is introduced.

## 10. Required security report

A security-sensitive investigation should explicitly state each applicable boundary as one of:

- verified at exact ref;
- not applicable;
- not found / possible defect;
- not verifiable with available access.

Do not silently omit a boundary because the first search did not find it.