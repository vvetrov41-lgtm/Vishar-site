# Telegram self-service linking and delivery

Status: Phase F-G implementation contract, Draft PR #391. Nothing in this file implies production activation.

## 1. Two different destinations

Telegram is intentionally split into two concepts that must never share an address implicitly.

### Personal destination

A personal destination belongs to one CRM profile.

- target key: `profile_id`
- accepted Telegram chat type: `private`
- purpose: CRM -> one person
- example: reminders and internal notifications addressed to that operator
- preference: `public.notification_preferences`, channel `telegram`
- private address mirror: `crm_private.profile_notification_targets`

A personal notification must never be delivered to an Artist's shared group just because the recipient works for that Artist.

### Artist/shared destination

An Artist destination belongs to one Artist operational scope.

- target key: `artist_id`
- accepted Telegram chat types: `group` or `supergroup`
- purpose: Artist business -> shared operational destination
- management authority: `manage_integrations` for that exact Artist

A manager who can configure Artist A cannot link or replace Artist B's group.

## 2. Private destination registry

Migration `0086_telegram_self_service.sql` introduces `crm_private.telegram_destinations`.

Chat IDs are capability-bearing routing values and remain server-only. They are not returned by browser RPCs, GPT actions or MCP tools.

The safe browser list exposes only:

- destination kind;
- Artist id when the target is Artist-scoped;
- safe target label;
- connected/not-connected state;
- safe display label;
- connection time.

## 3. Single-use linking

`public.begin_telegram_link()` creates a ten-minute challenge.

The raw start parameter is returned once to the authenticated CRM surface. PostgreSQL stores only its SHA-256 digest in `crm_private.telegram_link_sessions`.

Starting another challenge for the same target invalidates the previous unconsumed challenge.

The CRM builds Telegram links as follows:

- personal destination: `https://t.me/<bot>?start=<token>`
- Artist group: `https://t.me/<bot>?startgroup=<token>`

The Worker accepts the resulting `/start <token>` or `/start@<bot> <token>` message only on the exact `/webhook` endpoint.

## 4. Completion re-checks authority

The Telegram provider callback does not decide who owns the destination. The stored linking session does.

`public.service_complete_telegram_link()` is backend-only and:

1. hashes the supplied token;
2. locks one unconsumed, unexpired, non-invalidated session;
3. validates the Telegram chat id and chat type;
4. re-checks the target's current authorization;
5. writes or replaces exactly that target's private destination;
6. consumes the challenge.

For an Artist target, the requester must still be an active CRM profile with current `manage_integrations` authority for that Artist when completion occurs. Revoking access after challenge creation therefore closes the link before it can be consumed.

For a personal target, the profile must still be active and the chat must be private.

## 5. Internal notification delivery

In-app notifications remain the canonical record.

Telegram delivery uses `crm_private.telegram_notification_deliveries`, a separate lease/retry state. Reading or dismissing the CRM notification does not rewrite external delivery history.

Linking Telegram does not replay an old in-app backlog. A delivery row is materialised only for notifications created after the currently active personal destination was connected.

Before leasing a delivery the backend re-checks:

- active profile;
- enabled personal Telegram preference;
- active Telegram destination;
- current Artist scope when `notification.artist_id` is present;
- current workspace scope when `notification.workspace_id` is present.

Revocation therefore stops future personal Telegram delivery as well as hiding inaccessible notification content in the CRM.

## 6. Shared bot and legacy fallback

The new route uses one encrypted Worker secret:

`TELEGRAM_BOT_TOKEN`

Artist chat IDs are resolved from the private destination registry. Personal chat IDs are returned only by the narrow backend claim RPC.

The existing production bindings remain required during Phase G:

- `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION`
- `ARTIST_TELEGRAM_KRISTINA_HPRODUCTION`

Worker behavior during rollout is deliberate:

1. without the shared bot token, the existing Artist binding path remains canonical and the new destination resolver is not called;
2. with the shared bot token, the Worker prefers the matching private Artist destination;
3. if no registry row exists, or registry resolution itself fails, the Worker falls back to the same Artist's existing encrypted binding;
4. it never tries another Artist's destination.

The old Artist bindings are removed only after DB-backed delivery has been proven for each migrated Artist in production.

## 7. Provider webhook boundary

The tracked production Worker declares the Custom Domain:

`telegram.vishartattoo.com`

The Worker accepts linking traffic only at:

`https://telegram.vishartattoo.com/webhook`

`TELEGRAM_LINKING_ENABLED` is `false` in both the tracked config and the generated Phase G drain deployment config. While it is false, HTTP linking returns 404.

When linking is later activated, the Worker also requires the encrypted secret:

`TELEGRAM_WEBHOOK_SECRET`

The callback must present the same value in Telegram's `X-Telegram-Bot-Api-Secret-Token` header. Unknown Telegram updates are acknowledged without database access so they do not become a provider retry loop.

Cloudflare Access must not sit in front of the provider callback. Authentication is the Telegram webhook secret plus the server-owned single-use challenge.

## 8. Production activation order

Production activation is intentionally separate from this Draft implementation.

1. Create the one shared Vishar CRM Telegram bot through BotFather and record its
   token and public username. Nothing below can be pre-provisioned without it:
   `TELEGRAM_BOT_TOKEN` is that token, and the CRM connector identity is that
   username. This is the single step that has no repository, Cloudflare or
   database representation, so it has to happen first.
2. Apply the stacked database migrations through `0086` using the normal production database release gate.
3. Provision the Telegram Custom Domain and verify it points only to `vishar-telegram-drain-production`.

   As of this workstream `telegram.vishartattoo.com` resolves to nothing, while
   `instagram`, `whatsapp`, `calendar`, `monzo` and `gpt-actions` all resolve to
   Cloudflare. The tracked config already declares the route with
   `custom_domain = true`, so the guarded `wrangler deploy --strict` step creates
   it if it does not exist yet. A `--dry-run` does not create routes, so a green
   dry-run is not evidence that this domain attaches cleanly - the first real
   deploy is where that is proven.
4. Pre-provision exactly five Worker secrets:
   - `SUPABASE_SECRET_KEY`
   - `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION`
   - `ARTIST_TELEGRAM_KRISTINA_HPRODUCTION`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
5. Deploy the Worker through the guarded release workflow. This enables the scheduled drain but deliberately leaves `TELEGRAM_LINKING_ENABLED=false`.
6. Verify Vladimir and Kristina's legacy Artist alerts still deliver through their existing bindings.
7. Configure the public bot username in the CRM. This is public identity only, not a credential.
8. Register Telegram's webhook to the exact `/webhook` URL with the same secret-token value:

   ```
   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
     node scripts/activate-telegram-webhook.mjs register --confirm
   ```

   `verify` (the default) is read-only and needs only the bot token; `delete`
   is the rollback. The tool accepts no URL argument - it can only ever point
   at `https://telegram.vishartattoo.com/webhook`, it refuses to act without
   `--confirm`, it fails if Telegram settles on any other URL, and it redacts
   the token out of Telegram's own error text before printing anything.

   This is a script rather than a GitHub workflow on purpose. Automating one
   HTTPS call would mean storing the bot token and the webhook secret as GitHub
   secrets. GitHub already holds a Cloudflare API token because deploying is
   impossible without it; these two are avoidable, so they stay only in the
   encrypted Cloudflare Worker secrets where they are actually needed.
9. Enable linking in a separately reviewed production config change.
10. Link and prove one personal destination.
11. Link and prove each Artist group one at a time. The DB route becomes preferred only for that Artist; the old binding remains fallback.
12. After production evidence shows stable DB-backed delivery per Artist, remove the corresponding legacy static binding in a separate cleanup release.

Steps 1, 4, 8 and any external provider authorization require BotFather access,
production secrets or provider controls. None of them are performed by an
application migration, by CI, or by the guarded deploy workflow.

The guarded workflow fails closed before any of this is ready: its secret-name
check requires the exact five-name set above, and `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_WEBHOOK_SECRET` do not exist until steps 1 and 4 are done.

## 9. Rollback

Rollback does not require deleting destination history.

- `TELEGRAM_LINKING_ENABLED=false` immediately closes the public linking surface while leaving scheduled delivery intact.
- Disconnecting one destination deactivates only that target.
- Disabling a personal Telegram preference stops external personal delivery while retaining in-app notifications.
- Removing or failing the shared resolver path leaves the legacy same-Artist binding fallback in place during Phase G.
- Existing static Artist bindings are not removed as part of the self-service foundation release.

There is no global chat-id fallback.
