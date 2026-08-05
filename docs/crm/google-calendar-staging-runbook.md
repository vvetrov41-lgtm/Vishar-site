# Google Calendar staging runbook

This runbook completes the hosted staging validation for the separate Vladimir and Kristina Google Calendar connections introduced by PRs #179–#181.

## Safety boundary

- Keep PRs #179, #180 and #181 open, draft and unmerged.
- Do not deploy or modify production.
- Use synthetic CRM appointments only.
- Do not enable a recurring calendar drain before both artist flows pass hosted E2E.
- Never place OAuth codes, cookies, OTPs, client secrets, refresh tokens, Supabase backend keys or the token-encryption key in GitHub comments, chat or screenshots.
- Cloudflare Access and CORS are separate controls. Interactive connector routes must remain behind owner-only Access.

## 1. Create the Access application

Create one Cloudflare Access self-hosted application:

- Name: `Vishar Calendar Staging`
- Hostname: `calendar-staging.vishartattoo.com`
- Policy: allow only the owner email approved for staging
- Session duration: use the existing owner-only staging convention

Verify in a private browser session that `/health` cannot be read without completing Access.

## 2. Create the KV namespaces

Create two distinct staging-only Workers KV namespaces:

- `CALENDAR_OAUTH_STATE`
- `CALENDAR_OAUTH_TOKENS`

Record only their namespace IDs for the Wrangler binding change. Do not read or copy token-envelope values during ordinary validation.

Add exactly these bindings to `wrangler.calendar.staging.toml`:

```toml
[[kv_namespaces]]
binding = "CALENDAR_OAUTH_STATE"
id = "<STATE_NAMESPACE_ID>"

[[kv_namespaces]]
binding = "CALENDAR_OAUTH_TOKENS"
id = "<TOKENS_NAMESPACE_ID>"
```

The IDs must be different. Run the deploy-ready preflight before deployment:

```sh
npm run validate:calendar-staging:deploy-ready
```

## 3. Confirm encrypted secrets and variables

Configure the staging Worker with:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `CALENDAR_TOKEN_ENCRYPTION_KEY`
- `CALENDAR_OWNER_EMAILS`
- `VLADIMIR_ARTIST_ID`
- `VLADIMIR_GOOGLE_EMAIL`
- `KRISTINA_ARTIST_ID`
- `KRISTINA_GOOGLE_EMAIL`
- `SUPABASE_URL`
- exactly one of `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`

Keep `CALENDAR_DRAIN_ENABLED = "false"`.

Do not print secret values. Validation should report configured booleans only.

## 4. Guarded staging deployment

Use only the permanent PR #180 staging workflow and its documented PR marker. Before triggering it, verify:

- exact PR heads and bases;
- normal CI is green;
- both KV bindings are present;
- `workers_dev = false`;
- the only custom domain is `calendar-staging.vishartattoo.com`;
- no cron trigger exists;
- the CRM return URL is `https://vishar-crm-staging.pages.dev/integrations/calendar`.

Remove the deployment marker immediately after the guarded run.

## 5. Health and Access checks

After deployment:

1. Confirm unauthenticated `/health` is intercepted by Access.
2. Complete Access manually as the approved owner.
3. Confirm `/health` returns only boolean readiness fields.
4. Confirm both KV bindings report available.
5. Confirm Google OAuth, Supabase, artists, owner Access and CRM return configuration report available.
6. Confirm `scheduledDrain` remains `false`.
7. Confirm `workers.dev` remains disabled.

## 6. Connect Vladimir

From the CRM Calendar Connections page, use Vladimir's Connect action.

Complete Google consent manually with the exact approved Vladimir Google account. Do not share credentials or consent codes.

Verify:

- the CRM shows Vladimir as connected after reloading status from Supabase;
- Kristina remains independently disconnected;
- the Supabase integration row contains metadata only;
- no access or refresh token exists in Supabase;
- one encrypted envelope exists under Vladimir's artist-specific KV key;
- the envelope is not copied into logs or test output.

Reject and record the safe error code if any other Google account is selected.

## 7. Vladimir synthetic create/update/cancel E2E

Use one synthetic Vladimir appointment.

1. Confirm the appointment to enqueue calendar creation.
2. Invoke the drain through the explicitly approved temporary/manual staging mechanism.
3. Verify exactly one event appears in Vladimir's primary calendar.
4. Verify the CRM stores the provider event ID and reports synced.
5. Change the appointment time.
6. Invoke the drain and verify the same event is updated, not duplicated.
7. Cancel the appointment.
8. Invoke the drain and verify the event is removed.
9. Invoke the drain again and verify cancellation remains idempotent.

Do not enable a recurring cron for this test. Remove any temporary manual trigger after validation.

## 8. Connect and validate Kristina

Repeat the connection and synthetic create/update/cancel flow with the exact approved Kristina Google account.

Verify isolation explicitly:

- Kristina's event appears only in Kristina's primary calendar;
- Vladimir's event does not appear in Kristina's calendar;
- Kristina's event does not appear in Vladimir's calendar;
- each artist uses a separate encrypted KV envelope;
- provider event IDs and outbox acknowledgements retain the correct artist ID and integration key;
- no cross-artist token fallback occurs.

## 9. Negative cases

Validate with synthetic state only:

- wrong Google account;
- reused or expired OAuth state;
- missing refresh token;
- revoked refresh token / `invalid_grant`;
- corrupt encrypted KV envelope;
- Google `429` and `5xx` retry behaviour;
- stale outbox version retirement;
- expired lease recovery;
- duplicate create;
- repeated cancellation;
- Access denial for an unapproved identity.

Only safe machine error codes may reach the CRM or logs.

## 10. Disconnect validation

For each artist:

1. Open the connector's confirmation page from the CRM.
2. Confirm disconnect.
3. Verify best-effort Google revocation was attempted.
4. Verify the local encrypted envelope was deleted even if revocation failed.
5. Verify Supabase metadata reports disconnected.
6. Verify the other artist's connection is unchanged.

## 11. Completion gate

A recurring drain may be considered only after all of the following are true:

- Access protection verified;
- both KV namespaces bound and isolated;
- both exact Google accounts connected successfully;
- create/update/cancel passed for each artist;
- duplicate, stale, retry and cancellation semantics passed;
- no credential or PII leakage found;
- temporary E2E trigger removed;
- production remains unchanged.

Enabling a cron is a separate reviewed change and is not part of PRs #179–#181.
