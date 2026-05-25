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

Do not commit any secrets to the repository.

## Post-deploy checks

After deployment, test:

1. Aftercare assistant response.
2. Idea assistant response.
3. Lead submission and Telegram delivery (if possible).
4. CORS behavior from `vishartattoo.com`.
