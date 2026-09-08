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

## Model provider secrets

There is one, and it is optional:

- `OPENAI_API_KEY` — an external second opinion for reasoning and vision.

The DeepSeek, Qwen and Llama tiers all run on the `AI` binding above, so they
need no key and no account outside Cloudflare. See `docs/ai/model-routing.md`.

DeepSeek V4 Flash requires the Workers Paid plan or prepaid AI Gateway credits.
Without either, chains that lead with DeepSeek fall through to the next tier.

Model identifiers and per-task tier order are plain variables in
`wrangler.toml`, not secrets.

Do not commit any secrets to the repository.

## Post-deploy checks

After deployment, test:

1. Aftercare assistant response.
2. Idea assistant response.
3. Lead submission and Telegram delivery (if possible).
4. CORS behavior from `vishartattoo.com`.
