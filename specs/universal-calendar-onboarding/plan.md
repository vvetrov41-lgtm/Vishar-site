# Implementation Plan: Universal Google Calendar onboarding

## Trust boundaries touched

| Boundary | Before | After |
| --- | --- | --- |
| Artist selection | Worker regex + `VLADIMIR_*`/`KRISTINA_*` vars | backend-only `resolve_calendar_artist_route` over the CRM access graph |
| Operator admission | Worker email allowlist (`calendarActorEmails`) | Cloudflare Access proves identity; Supabase proves `manage_integrations` |
| Expected Google account | Worker variable | `artist_integrations.external_account_label`, pinned on first bind |
| Integration key | Worker constant | database trigger `google_calendar_' || artists.slug` |
| Token custody | encrypted KV `artist:<uuid>` | unchanged |

Cloudflare Access remains a necessary but insufficient gate. Every state-changing path still calls the backend RPC, so an Access identity with no CRM capability reaches nothing.

## Database (migration `0137_universal_calendar_artist_routing.sql`)

Additive only. No earlier migration is edited.

1. Guard block: fail if any existing `calendar` row already violates the new invariants (key not `google_calendar_<slug>`, provider not `google`, duplicate account label).
2. `crm_private.enforce_exact_calendar_artist_route_key()` + trigger on `artist_integrations` (mirrors `0129` for WhatsApp).
3. Partial unique index `artist_integrations_calendar_account_unique` on `lower(external_account_label)` where `integration_type = 'calendar'`.
4. `crm_private.calendar_presentation_defaults(p_artist_id)` returning the default presentation object.
5. Replace `public.set_calendar_connection_metadata` — slug-generic, preserves existing `presentation`, pins the account label, rejects a label change while a pin exists, rejects a label already used by another artist.
6. Replace `public.list_calendar_connection_status()` — no slug allowlist, ordered by display name.
7. New backend-only `public.resolve_calendar_artist_route(text, text)`.
8. New authenticated `public.reset_calendar_expected_account(uuid)`.
9. Backfill `configuration.presentation` for `vladimir` (visibility `public`, display `Vladimir`, colour `9`) and `kristina` (visibility `public`, display `Kristina`, label `Wisteria` / `#b39ddb`) so today's projected events are byte-identical.

`public.authorize_calendar_actor` stays as-is for compatibility; the new resolver reuses the same predicate.

## Worker

`workers/lib/calendar-oauth-security.js`

- delete `ALIASES`, `calendarActorEmails`, `canManageCalendarAlias`;
- `verifiedCalendarActorEmail` verifies the Access JWT and returns the email without an artist allowlist;
- `buildOAuthStateRecord(artistId, slug, verifier, actorEmail)` and `consumeOAuthState` validate a UUID artist id;
- `buildDisconnectStateRecord` / `consumeDisconnectState` keyed by artist UUID;
- `disconnectConfirmationPage` takes a server-provided display name;
- `calendarReadiness` drops the two-artist configuration check.

`workers/calendar-oauth.js`

- `ARTIST_REF_PATTERN = /^(?:[a-z][a-z0-9-]{1,62}|<uuid>)$/`;
- `resolveArtistRoute(actorEmail, artistRef, env, fetchImpl)` calls the RPC and maps `null` to `calendar_artist_access_denied` (403);
- start/callback/disconnect all take the resolved route object;
- callback re-resolves by the state's artist UUID, then compares the verified Google account against `expected_account_email` when one exists;
- event-label lookup reads the resolved presentation, not env.

`workers/lib/google-calendar.js`

- `calendarRouteConfig(route)` derives alias, integration key shape, expected email and presentation from the backend-resolved outbox route;
- `validateCalendarRoute` uses it; `artistCalendarConfig(env, artistId)` is removed.

## Frontend

- `CalendarConnectorAlias` becomes `string` constrained by the slug shape; `integration_key` validated as `google_calendar_<slug>`;
- `validateResult` drops the two-row cap;
- `connectionResultNotice` uses the returned display names instead of hardcoded names;
- a "Change Google account" action calls `reset_calendar_expected_account` when disconnected.

## Configuration

- Remove `VLADIMIR_*` / `KRISTINA_*` vars from `wrangler.calendar.production.toml` and `wrangler.calendar.staging.toml`.
- `scripts/validate-calendar-*.mjs` assert the vars are absent rather than present.

## Tests

- `scripts/test-calendar-oauth-hardening.mjs`: unknown artist, inactive artist, unauthorized operator, cross-artist state substitution, disconnect nonce substitution.
- `scripts/test-calendar-worker.mjs`: generic start/callback/disconnect, first-bind, account mismatch, metadata rollback.
- `supabase/tests/198_universal_calendar_routing.sql`: trigger, unique index, resolver authorization matrix, presentation preservation, reset semantics.
- `admin/src/test/calendar-connections*.test.ts`: arbitrary slug accepted, mismatched key rejected.

## Rollout

1. Push branch, exact-head CI green.
2. Apply `0137` to staging Supabase, run pgTAP.
3. Apply `0137` to production Supabase.
4. Redeploy the production Calendar Worker via `deploy-private-production-calendar.yml`.
5. Readback: `/health`, `list_calendar_connection_status`, Vladimir/Kristina rows unchanged.
6. Acceptance: third-artist connect (interactive Google consent).

Rollback: the previous Worker deployment is re-deployable; `0137` is additive and the old Worker code path is not reintroduced by it because the replaced functions stay slug-generic supersets of the old behaviour for the two existing slugs.
