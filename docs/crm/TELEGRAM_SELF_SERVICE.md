# Telegram self-service linking and delivery

Status: Phase F-G implementation contract, Draft PR #391. Nothing in this file implies production activation.

## 1. Two destination types

Telegram intentionally has two independent destination scopes.

### Personal destination

- target: one CRM `profile_id`
- Telegram chat type: `private`
- purpose: internal CRM reminders and notifications addressed to that person
- preference: `public.notification_preferences`, channel `telegram`
- private address mirror: `crm_private.profile_notification_targets`

A personal notification must never be routed to an Artist group merely because the person works for that Artist.

### Artist shared destination

- target: one `artist_id`
- Telegram chat type: `group` or `supergroup`
- purpose: Artist operational notifications
- management authority: current `manage_integrations` for that Artist

A manager with access to Artist A cannot link or replace Artist B's group.

## 2. Private destination registry

Migration `0086_telegram_self_service.sql` introduces:

- `crm_private.telegram_destinations`
- `crm_private.telegram_link_sessions`
- `crm_private.telegram_connector_settings`
- `crm_private.telegram_notification_deliveries`

Chat IDs are capability-bearing routing values. They remain server-only and are not returned by browser RPCs, GPT actions or MCP tools.

The safe browser surface exposes only destination kind, Artist id when applicable, safe labels, connection state and timestamps.

## 3. Single-use linking

`public.begin_telegram_link()` creates a roughly ten-minute challenge.

The raw start parameter is returned once to the authenticated CRM surface. PostgreSQL stores only its SHA-256 digest. Starting a second challenge for the same target invalidates the earlier unconsumed challenge.

The public bot identity is stored separately from credentials. The shared bot created for this rollout is:

`VisharCRMBot`

Expected links after migration 0086 is deployed and the connector identity is configured:

- personal: `https://t.me/VisharCRMBot?start=<token>`
- Artist group: `https://t.me/VisharCRMBot?startgroup=<token>`

The opaque token carries no Artist id and no chat id.

Telegram Privacy Mode should remain enabled. A command addressed to the bot, including the group `/start@VisharCRMBot <token>` command produced by `startgroup`, is still delivered to the bot. There is no reason for the bot to receive ordinary group messages.

## 4. Completion re-checks current authority

`public.service_complete_telegram_link()` is backend-only. It:

1. hashes the supplied token;
2. locks one unconsumed, unexpired, non-invalidated session;
3. validates Telegram chat id and chat type;
4. re-checks current CRM authorization;
5. writes or replaces exactly that target's private destination;
6. consumes the challenge.

For an Artist target, the requester must still have current `manage_integrations` authority when completion happens. Revoking access after challenge creation therefore blocks completion.

For a personal target, the CRM profile must still be active and the Telegram chat must be private.

## 5. Personal notification delivery

In-app notifications remain canonical.

Telegram delivery has separate lease/retry state in `crm_private.telegram_notification_deliveries`. Reading a CRM notification does not rewrite external-delivery history.

Linking Telegram does not replay the historical in-app backlog. Delivery rows are materialised only for notifications created after the current personal destination was connected.

Before external delivery, the backend re-checks:

- active profile;
- enabled Telegram notification preference;
- active Telegram destination;
- current Artist access when `notification.artist_id` is present;
- current workspace access when `notification.workspace_id` is present.

Revoked scope therefore blocks future external delivery.

## 6. Shared bot and legacy Artist fallback

The shared bot credential is an encrypted Cloudflare Worker secret:

`TELEGRAM_BOT_TOKEN`

It must never be committed, logged, placed in Supabase, placed in a PR body, or pasted into a chat.

During Phase G the two existing Artist-specific encrypted bindings remain required:

- `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION`
- `ARTIST_TELEGRAM_KRISTINA_HPRODUCTION`

Delivery behavior during transition:

1. without the shared bot token, the old same-Artist binding remains canonical and the DB destination resolver is not required;
2. with the shared bot token, the Worker prefers the matching private DB Artist destination;
3. if that destination does not exist, or resolver lookup fails, the Worker falls back only to the same Artist's legacy binding;
4. it never tries another Artist and there is no global Telegram chat-id fallback.

Legacy bindings are retired only after DB-backed delivery is proven per Artist in production.

## 7. Provider webhook boundary

Target Custom Domain:

`telegram.vishartattoo.com`

Exact callback:

`https://telegram.vishartattoo.com/webhook`

The Worker rejects every other HTTP path. When linking is enabled it also requires:

`TELEGRAM_WEBHOOK_SECRET`

Telegram must present that same secret in `X-Telegram-Bot-Api-Secret-Token`.

Unknown Telegram updates are acknowledged without DB access to avoid provider retry loops. Invalid, expired, revoked or consumed linking challenges are deliberately opaque. Transient backend 5xx/429 failures return a retryable response so a valid unconsumed challenge is not silently lost.

Cloudflare Access must not sit in front of this provider callback.

## 7a. Live production Worker also schedules Gmail

This is a critical production invariant.

Read-only Cloudflare audit on 2026-08-22 found the live `vishar-telegram-drain-production` Worker already owns the shared five-minute scheduler used by both Telegram and Gmail.

Observed state at that audit, before any Phase G rollout:

| Item | State on 2026-08-22 |
| --- | --- |
| Active version | `c6fc73e8-281a-4715-86c5-ae2d7d43e9b1` |
| Deployment date | 2026-08-19 |
| Cron | `*/5 * * * *` |
| `workers.dev` | disabled |
| preview URLs | disabled |
| compatibility date | `2026-05-25` |
| secret names | `ARTIST_TELEGRAM_KRISTINA_HPRODUCTION`, `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION`, `SUPABASE_SECRET_KEY` |
| service binding | `GMAIL_SERVICE -> vishar-gmail-production` |
| Gmail flag | `GMAIL_SHARED_DRAIN_ENABLED="true"` |

Cloudflare plain-text vars and Service Bindings are deployment configuration. A new Wrangler deploy can replace them. Therefore a Telegram self-service deploy that omitted the Gmail binding or its Worker dispatch would stop the production Gmail approved-email drain.

PR #391 now explicitly carries the already-live Gmail shared scheduler contract rather than merely detecting it:

- tracked config contains inert `GMAIL_SHARED_DRAIN_ENABLED="false"`;
- generated production config sets `GMAIL_SHARED_DRAIN_ENABLED="true"`;
- generated config adds `GMAIL_SERVICE -> vishar-gmail-production`;
- `workers/telegram-drain-worker.js` preserves the bounded `drainApprovedEmailOutbox()` Service Binding call;
- no Gmail OAuth secret, token-encryption secret, KV binding or provider credential moves into the Telegram Worker.

`scripts/preflight-telegram-production.mjs` reads live Cloudflare state before deployment and blocks silent removal of live replaceable bindings. It also validates the Gmail target, live Gmail flag, secret names, cron, Custom Domain conflicts, DNS conflicts, Cloudflare Access, `workers.dev`, previews and linking state transitions.

The rollout has since happened and the invariant held. Read-only Cloudflare readback on 2026-08-23:

| Item | Live state on 2026-08-23 |
| --- | --- |
| Active version | `47e7bf8c-f532-4564-a88d-59b307ba75fb` |
| Active deployment | `7134e3ec-b84d-43cb-8ffa-6c65c47118b6` at 100% |
| Cron | `*/5 * * * *` |
| `workers.dev` | disabled |
| preview URLs | disabled |
| compatibility date | `2026-08-22` |
| secret names | `ARTIST_TELEGRAM_KRISTINA_HPRODUCTION`, `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION`, `SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |
| service binding | `GMAIL_SERVICE -> vishar-gmail-production` |
| Gmail flag | `GMAIL_SHARED_DRAIN_ENABLED="true"` |
| Telegram flag | `TELEGRAM_DRAIN_ENABLED="true"` |
| linking flag | `TELEGRAM_LINKING_ENABLED="true"` |
| Custom Domain | `telegram.vishartattoo.com`, attached and enabled |

The Gmail Service Binding and enable flag survived both Phase G deploys, which is the outcome this section exists to protect.

## 8. Production activation order

Steps 1 to 6 have been completed in production. Step 7 onwards has not. Each step below records its verified status; anything still open remains subject to separate approval.

### Step 1. Shared bot — done

Already completed externally.

Public username:

`VisharCRMBot`

The token is private and remains outside the repo and chat history.

### Step 2. Database stack — done

Apply the normal production migration lineage through `0086` only through the protected production database release process.

This was not a one-migration deployment: production was at `0073`, so the full stacked lineage `0074` through `0086` was handled as the normal platform rollout, completed on 2026-08-22 from `release/private-crm-rc77-platform-foundation` at `5fde7507`.

Verified on 2026-08-23: migration head `0086`, `public.configure_telegram_connector_identity(text)` present, `crm_private.telegram_destinations` and `crm_private.telegram_link_sessions` both empty.

### Step 3. Connector identity — done

After `0086` exists in production, configure the public bot username through the CRM owner RPC:

`VisharCRMBot`

Verified on 2026-08-23: the connector settings singleton reports `bot_username = VisharCRMBot`.

No bot token belongs in the database.

### Step 4. Cloudflare secrets — done

The production Telegram Worker must have exactly these encrypted secret names during Phase G:

- `SUPABASE_SECRET_KEY`
- `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION`
- `ARTIST_TELEGRAM_KRISTINA_HPRODUCTION`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

The two legacy Artist secrets remain until migration equivalence is proven.

Verified on 2026-08-23: exactly these five names are present. Only names were read; no secret value is read, printed or stored by CI or by this runbook.

### Step 5. First guarded Worker deploy, linking still off — done

Run the protected production Telegram deployment with normal deploy approval and:

- `enable_linking=false`
- `disable_linking=false`

Generated state:

- Telegram drain enabled;
- Gmail shared drain enabled;
- `GMAIL_SERVICE -> vishar-gmail-production` preserved;
- exact cron `*/5 * * * *`;
- linking disabled;
- Custom Domain declared;
- `workers.dev=false`;
- preview URLs disabled.

This first real deploy is also where creation of `telegram.vishartattoo.com` is actually proven. A dry-run cannot prove Custom Domain attachment.

Do not use `wrangler deploy --strict` for this step. An earlier attempt (run `32599525230`) passed the fail-closed preflight and the dry-run, then aborted before upload because `--strict` rejects the intended differences of this very rollout: the compatibility-date change, the newly added `TELEGRAM_LINKING_ENABLED` var, and Wrangler's normalisation of the Service Binding `environment` field. `--strict` cannot express "this reviewed diff is authorized". The workflow in PR #393 removes `--strict` from the real deploy only, keeps the preflight and dry-run before it, and re-runs the same preflight afterwards as control-plane readback. Deploy from that lineage, not from PR #391 alone.

Completed on 2026-08-23 by run `32601337163` from `release/private-crm-rc78-telegram-strict-recovery` at `8ebef21`, producing version `58f9245a-e6a0-4b3b-89cb-73d9892382bc` with linking still off.

After deployment verify:

- deployed Worker/version;
- one exact five-minute cron;
- Gmail Service Binding still present;
- Gmail shared drain still functioning;
- Vladimir and Kristina legacy Telegram alerts still functioning;
- `https://telegram.vishartattoo.com/webhook` returns 404 while linking is off;
- no Cloudflare Access app covers the callback.

### Step 6. Enable linking through the separate gate — done

A second production Worker deployment enables linking. It requires all normal production approval plus:

`ENABLE_TELEGRAM_LINKING`

The workflow generates `TELEGRAM_LINKING_ENABLED="true"` only when that independent gate is present. The preflight also requires `--allow-linking`.

This deploy still preserves Telegram drain, Gmail shared drain, cron and legacy fallback.

Completed on 2026-08-23 by run `32623927810` from the same `8ebef21` head, producing version `47e7bf8c-f532-4564-a88d-59b307ba75fb` with `TELEGRAM_LINKING_ENABLED="true"`.

With linking on, the live boundary was verified by read-only probes and fails closed:

| request | response |
| --- | --- |
| `GET /` | `404` |
| `GET /anything` | `404` |
| `GET /webhook` | `405` |
| `POST /notwebhook` | `404` |
| `POST /webhook` with no secret header | `401` |
| `POST /webhook` with a wrong secret header | `401` |

### Step 7. Register Telegram webhook — not done

This is the next open step. It cannot be performed or verified from CI or from an agent session: `setWebhook` requires the bot token, which is deliberately held only as the encrypted Cloudflare Worker secret. Until it is registered, the Worker is live and fails closed but Telegram sends it nothing.

Only after the linking-enabled Worker is live, register Telegram's webhook:

`https://telegram.vishartattoo.com/webhook`

Use `scripts/activate-telegram-webhook.mjs`. The tool accepts no arbitrary URL, register/delete require `--confirm`, and output redacts credentials.

`verify` is read-only. Registration must use the same secret value as the encrypted Worker secret `TELEGRAM_WEBHOOK_SECRET`.

Immediately verify Telegram reports the exact callback URL.

### Step 8. Controlled E2E

Prove in this order:

1. one personal destination;
2. Vladimir shared Artist group;
3. Kristina shared Artist group;
4. legacy same-Artist fallback remains available;
5. no cross-Artist routing.

Only after stable evidence should legacy Artist bindings be considered for a later cleanup release.

## 9. Linking rollback

The routine production deploy is deliberately unable to silently change a live linking state.

If linking is already live and a generated config would disable it, Cloudflare preflight fails unless the dedicated rollback gate is used.

The guarded rollback requires:

- `deploy=true`;
- `disable_linking=true`;
- `enable_linking=false`;
- normal production deploy phrase;
- separate rollback phrase `DISABLE_TELEGRAM_LINKING`.

That deploy sets `TELEGRAM_LINKING_ENABLED=false` while preserving Telegram scheduled delivery, Gmail shared drain, the five-minute cron and legacy Artist fallback.

After an emergency rollback, Telegram webhook registration can be deleted separately with the guarded activation tool if required. Destination history does not need to be deleted.

Other rollback properties:

- disconnecting one destination deactivates only that target;
- disabling a personal Telegram preference stops external personal delivery while retaining in-app notifications;
- failure or absence of a DB Artist destination retains same-Artist legacy fallback during Phase G;
- no global chat-id fallback exists.

## 10. Future Artist invariant

After cutover, onboarding a new Artist must not require:

- GitHub code changes;
- Wrangler changes;
- a new Worker;
- a new Cloudflare secret;
- a new Telegram bot;
- a Supabase migration;
- a hard-coded Artist id.

Expected Artist flow:

CRM -> Integrations -> Telegram -> Connect shared group -> `t.me/VisharCRMBot?startgroup=<challenge>` -> select group -> connected.

Expected personal flow:

CRM -> Notifications -> Connect Telegram -> `t.me/VisharCRMBot?start=<challenge>` -> private chat -> connected.
