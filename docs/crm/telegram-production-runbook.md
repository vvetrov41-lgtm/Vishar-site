# Telegram production rollout runbook

This runbook activates the already-staging-proven bounded Telegram outbox drain for the production CRM without replaying historical jobs or introducing global provider fallbacks.

## Fixed runtime boundary

- Product source must contain PR #191 exact head `314f0359ad083cec4efc7ea389d3111e2d83b755` in its ancestry.
- Dedicated Worker: `vishar-telegram-drain-production`.
- Worker entrypoint: `workers/telegram-drain-worker.js`.
- `workers_dev=false`, `preview_urls=false`, no public route or Custom Domain.
- Exact schedule when activated: `*/5 * * * *`.
- Default batch 10, database hard maximum 20, lease 120 seconds by default.
- Production Supabase project only: `vfjexhfdbrjmuxfdvbdx`.
- Retained staging project `gwaliusblwrzisrwnsvs` must never be referenced by the production deploy config.

## Artist routes and encrypted bindings

Production route metadata must exist for the active artists only after the dedicated Worker has all required encrypted bindings.

| artist | integration key | derived Worker secret name |
| --- | --- | --- |
| Vladimir | `vladimir-production` | `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION` |
| Kristina | `kristina-production` | `ARTIST_TELEGRAM_KRISTINA_HPRODUCTION` |

The Worker must contain exactly three encrypted secrets: `SUPABASE_SECRET_KEY` and the two artist-scoped bindings above. Do not add generic Telegram token/chat bindings. Secret values are supplied out of band and are never copied into the repository, Supabase metadata, logs, PR descriptions or evidence artifacts.

Each artist binding is the JSON credential envelope expected by `resolveProviderBinding` and `sendNotification`. The database stores only `provider=telegram`, the non-secret integration key, a safe account label if useful, and credential-free configuration.

## Activation order

1. Fresh-check product/RC exact heads, ancestry and normal exact-head CI.
2. Verify production migration history includes `0035` and `0036`, effective ACL is service-role-only, and the production Telegram outbox contains no unexpected eligible rows.
3. Verify the retained staging cutoff and historical rows are unchanged.
4. Pre-provision the dedicated production Worker in an inert state and add only the three required encrypted secret names/values. Do not create a cron yet.
5. Run the guarded Telegram production workflow validation against the exact RC SHA.
6. Deploy the generated config: it enables `TELEGRAM_DRAIN_ENABLED=true` and adds exactly one five-minute cron. The tracked template remains inert.
7. Verify the deployed Worker version, no routes, workers.dev disabled, preview URLs disabled, exact cron and exact secret-name set.
8. Create or enable the two production `artist_integrations` Telegram rows using the integration keys above. Re-check that their `configuration` contains no credential-shaped keys or values.
9. Re-check production outbox counts immediately. No existing row may have changed as a side effect of rollout.
10. Re-check retained staging. The seven historical Vladimir failures and prior #189/#190 targets must remain unchanged.

Do not send a synthetic production Telegram message. The first new genuine production enquiry/notification after activation is the production delivery E2E evidence.

## Rollback

If the scheduled runtime misbehaves before a genuine job is processed, remove the cron or deploy the inert tracked configuration and disable the two production integration rows. Do not modify old outbox rows. If a genuine job was already attempted, preserve its row/activity evidence and fix forward rather than rewriting delivery history.
