# Google Calendar staging runbook

This runbook completes the hosted staging validation for the separate Vladimir and Kristina Google Calendar connections introduced by PRs #179–#181.

## Safety boundary

- Keep PRs #179, #180 and #181 open, draft and unmerged.
- Do not deploy or modify production.
- Use synthetic CRM appointments only.
- Do not enable a recurring calendar drain before both artist flows pass hosted E2E.
- Never place OAuth codes, cookies, OTPs, client secrets, refresh tokens, Supabase backend keys or the token-encryption key in GitHub comments, chat or screenshots.
- Cloudflare Access and CORS are separate controls. Interactive connector routes must remain behind owner-only Access and must validate the signed Access application JWT inside the Worker.

## 1. Access and routing configuration

The owner-only Cloudflare Access application protects:

- `calendar-staging.vishartattoo.com`
- team origin `https://vishar-site-pages.cloudflareaccess.com`
- Calendar application AUD `2a0569d2cc1acb785ccf190585be7ca9cad70fe6db7042a8094bf39160a26013`
- approved owner `vvetrov41@gmail.com`

The exact team origin, AUD, owner allowlist, artist IDs, expected Google account labels and retained staging Supabase URL are committed as non-secret staging variables and validated fail-closed by `validate-calendar-staging.mjs`.

Verify in a private browser session that `/health` cannot be read without completing Access.

## 2. KV namespaces

The following distinct staging-only Workers KV namespaces are bound:

- `CALENDAR_OAUTH_STATE`
- `CALENDAR_OAUTH_TOKENS`

`CALENDAR_OAUTH_STATE` stores short-lived PKCE/OAuth state and single-use disconnect confirmation nonces. `CALENDAR_OAUTH_TOKENS` stores only AES-GCM encrypted refresh-token envelopes.

Do not read or copy token-envelope values during ordinary validation. Run the deploy-ready preflight before deployment:

```sh
npm run validate:calendar-staging:deploy-ready
```

## 3. Remaining encrypted secrets

The guarded PR #180 workflow reads these secret names from the GitHub `staging` environment and uploads them atomically with the Worker deployment through a temporary mode-`0600` file that is deleted immediately afterward:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `CALENDAR_TOKEN_ENCRYPTION_KEY`
- `SUPABASE_SECRET_KEY`

The repository already uses these staging deployment credentials:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`CALENDAR_TOKEN_ENCRYPTION_KEY` must be a base64url value that decodes to exactly 32 random bytes. Never place any of the secret values in a PR body, comment, chat, screenshot, committed file or workflow output.

Keep:

- `CRM_RETURN_URL = "https://vishar-crm-staging.pages.dev/#/integrations/calendar"`
- `CRM_APPOINTMENTS_URL = "https://vishar-crm-staging.pages.dev/#/appointments"`
- `CALENDAR_DRAIN_ENABLED = "false"`

The two CRM URLs are intentionally separate. OAuth and Disconnect return to Calendar Connections; links projected into Google events return to Appointments. Both preserve the CRM hash router.

## 4. Guarded staging deployment

There are two separate permanent workflows. Neither runs without its exact PR marker.

### 4.1 Database and CRM Pages from PR #181

Run `PR 181 retained staging Calendar Connections` first by adding its documented marker to PR #181 only after normal CI is green.

The workflow must:

- verify PR #181 remains open, draft and unmerged;
- verify its exact base is the current open, draft and unmerged PR #180 head;
- accept retained staging only when migrations are consecutive through `0028`, `0029` or `0030`;
- apply only forward migrations `0029` and/or `0030` when missing;
- reject any migration after `0030`;
- prove retained clients, enquiries, projects, appointments, outbox and activity counts are unchanged by migration;
- verify the narrow Calendar drain and Calendar Connections RPC ACLs;
- run hosted PostgreSQL error-level lint;
- rebuild and test the exact CRM artifact;
- deploy only the `vishar-crm-staging` Pages project;
- verify the canonical CRM hostname remains protected by Cloudflare Access;
- not deploy the Calendar Worker, Booking Pages, intake Worker or production.

Remove the PR #181 marker immediately after the guarded run.

### 4.2 Calendar Worker from PR #180

After all four Calendar Worker secrets are present in the GitHub `staging` environment, run the permanent PR #180 Calendar staging workflow with its documented marker.

The workflow must:

- verify PR #180 remains open, draft and unmerged at its exact current head;
- require green normal CI;
- verify the exact Access origin, AUD, owner/artist routing and retained Supabase URL;
- verify both KV bindings are present with distinct valid namespace IDs;
- keep `workers_dev = false` and cron absent;
- deploy only `vishar-calendar-staging`;
- create or preserve only the custom domain `calendar-staging.vishartattoo.com`;
- upload the four encrypted secrets without printing their values;
- verify unauthenticated requests remain intercepted by Access;
- not perform Google OAuth, create Calendar events, enable cron or target production.

Remove the PR #180 marker immediately after the guarded run.

## 5. Health, Access and JWT checks

After deployment:

1. Confirm unauthenticated `/health` is intercepted by Access.
2. Complete Access manually as the approved owner.
3. Confirm `/health` returns only boolean readiness fields.
4. Confirm both KV bindings report available.
5. Confirm Google OAuth, Supabase, artists, Access-JWT configuration and both CRM URLs report available.
6. Confirm `scheduledDrain` remains `false`.
7. Confirm `workers.dev` remains disabled.
8. Confirm an interactive route rejects a request with no Access JWT.
9. Confirm a forged email header without a valid signed JWT is rejected.
10. Confirm a valid JWT issued for another Access AUD is rejected.

Do not copy the JWT into logs, screenshots or chat.

## 6. Connect Vladimir

From the CRM Calendar Connections page, use Vladimir's Connect action.

Complete Google consent manually with `vvetrov41@gmail.com`. Do not share credentials or consent codes.

Verify:

- the browser returns to the Calendar Connections hash route;
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
4. Verify the event's CRM link opens the Appointments hash route, not Calendar Connections.
5. Verify the CRM stores the provider event ID and reports synced.
6. Change the appointment time.
7. Invoke the drain and verify the same event is updated, not duplicated.
8. Cancel the appointment.
9. Invoke the drain and verify the event is removed.
10. Invoke the drain again and verify cancellation remains idempotent.

Do not enable a recurring cron for this test. Remove any temporary manual trigger after validation.

## 8. Connect and validate Kristina

Repeat the connection and synthetic create/update/cancel flow with `tinaakaten@gmail.com`.

Verify isolation explicitly:

- Kristina's event appears only in Kristina's primary calendar;
- Vladimir's event does not appear in Kristina's calendar;
- Kristina's event does not appear in Vladimir's calendar;
- each artist uses a separate encrypted KV envelope;
- provider event IDs and outbox acknowledgements retain the correct artist ID and integration key;
- no cross-artist token fallback occurs.

## 9. Negative cases

Validate with synthetic state only:

- missing or invalid Access JWT;
- valid Access JWT with the wrong AUD;
- forged forwarded email header;
- wrong Google account;
- reused or expired OAuth state;
- Google consent denial followed by OAuth-state replay;
- missing refresh token;
- revoked refresh token / `invalid_grant`;
- corrupt encrypted KV envelope;
- Google HTTP `429` retry behaviour;
- Google HTTP `403` with `rateLimitExceeded`, `userRateLimitExceeded` or `quotaExceeded` remains transient;
- Google HTTP `403` permission failure is dead-lettered as permanent;
- Google `5xx` retry behaviour;
- stale outbox version retirement;
- expired lease recovery;
- duplicate create;
- repeated cancellation;
- reused, expired, wrong-artist or wrong-owner disconnect nonce;
- Access denial for an unapproved identity.

Only safe machine error codes may reach the CRM or logs.

## 10. Disconnect validation

For each artist:

1. Open the connector's confirmation page from the CRM.
2. Confirm that the page contains a short-lived, single-use confirmation nonce without exposing it in the URL.
3. Confirm disconnect.
4. Verify a replay of the same POST is rejected before token deletion or metadata changes.
5. Verify best-effort Google revocation was attempted.
6. Verify the local encrypted envelope was deleted even if revocation failed.
7. Verify Supabase metadata reports disconnected.
8. Verify the other artist's connection is unchanged.
9. Verify the browser returns to the Calendar Connections hash route.

## 11. Completion gate

A recurring drain may be considered only after all of the following are true:

- Access protection and Worker-side JWT validation verified;
- both KV namespaces bound and isolated;
- both exact Google accounts connected successfully;
- create/update/cancel passed for each artist;
- duplicate, stale, retry and cancellation semantics passed;
- disconnect nonce replay and cross-identity cases rejected;
- no credential, JWT or PII leakage found;
- temporary E2E trigger removed;
- production remains unchanged.

Enabling a cron is a separate reviewed change and is not part of PRs #179–#181.
