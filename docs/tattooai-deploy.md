# tattooai Worker deployment

This workflow deploys the existing `tattooai` Cloudflare Worker.

## Deployment mode

- Manual only (`workflow_dispatch`).
- Run deployment only after PR review and merge.

## Required GitHub secrets

Set these repository secrets before running the workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Existing Cloudflare Worker runtime configuration that must remain in place

- Workers AI binding: `AI` (binding name must be `AI`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Optional model-provider secrets

The public assistants route through the capability router described in
`docs/ai/model-routing.md`. These secrets are optional: with none of them set,
both live chains resolve to the existing `AI` binding and behaviour is unchanged.

- `DEEPSEEK_API_KEY` — enables the low-cost text tier
- `QWEN_API_KEY` — enables the multimodal tier
- `OPENAI_API_KEY` — enables the quality tier and cross-provider fallback

Set them with `wrangler secret put <NAME>` against the `tattooai` Worker, or in
the Cloudflare dashboard. Model identifiers and per-task provider order are
plain variables in `wrangler.toml`, not secrets.

Do not commit any secrets to the repository.

## Post-deploy checks

After deployment, test:

1. Aftercare assistant response.
2. Idea assistant response.
3. Lead submission and Telegram delivery (if possible).
4. CORS behavior from `vishartattoo.com`.
