# tattooai Worker deployment

The production `tattooai` Worker owns durable CRM booking intake, enquiry AI
and CRM agent drains. Its source is `workers/tattooai-entry.js` on the CRM
trunk (`agent/platform-telegram-self-service`), and it is released only by the
guarded CRM release workflow `tattooai-production-release.yml` from an exact,
immutable release SHA.

This public-site branch intentionally contains no Worker config and no deploy
workflow for `tattooai`. The legacy `workers/tattooai.js` here is a
Telegram-only handler kept for `npm run test:booking`; deploying it would
bypass the CRM entirely. `npm run validate:site` fails if a `wrangler.toml`
or workflow that can deploy it is reintroduced (audit finding C-1).
