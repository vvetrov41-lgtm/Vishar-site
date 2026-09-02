# GPT v2 Firecrawl rollout target

This note removes an ambiguity discovered during the first Firecrawl rollout.

## Product target

The external product target is **Vishar CRM Unified GPT v2**. There is no separate "Operations GPT" product in this rollout.

`gpt-operations.vishartattoo.com` is an Action transport/domain used by GPT v2. A schema or route hosted there must not be described as being installed into, assigned to, or rolled out to an "Operations GPT".

The current Web Research operations are:

- `searchWeb` -> `POST https://gpt-operations.vishartattoo.com/v1/web/search`
- `scrapeWebPage` -> `POST https://gpt-operations.vishartattoo.com/v1/web/scrape`

They are projected in `docs/gpt-actions/openapi.production.operations.yaml` because that is the current importable domain schema. The host/domain name does not define the Custom GPT identity.

## Builder boundary

When applying this rollout in the external Custom GPT editor:

1. Target the existing **GPT v2** configuration.
2. Import/update the Operations Action schema from the same immutable repository SHA as the other GPT v2 schemas.
3. Keep the existing verified OAuth application/configuration unless a separate OAuth migration has been explicitly approved.
4. Confirm the imported schema exposes `searchWeb` and `scrapeWebPage` and points them at `gpt-operations.vishartattoo.com`.
5. Do not create, repoint, rename, or treat a separate "Operations GPT" as the product target.

The production Worker host remains the correct runtime edge for these routes. Changing the Custom GPT target does not require moving the Firecrawl routes to another hostname.

## Client activation boundary

Do not activate or repoint `vishar-unified-gpt` merely to correct this naming/Builder-target mistake. Database GPT client activation and OAuth binding are separate production control-plane changes and require their own fresh-check and acceptance path.

Firecrawl capability must be verified against the actual production OAuth client used by GPT v2 before Builder acceptance. A green Worker route alone is not proof that GPT v2 can call it.

## Acceptance

The rollout is accepted only when all of the following are true on fresh state:

- canonical exact-head CI is green for the release SHA;
- the production Worker exposes `/v1/web/search` and `/v1/web/scrape` with the reviewed OAuth/capability boundary;
- the production OAuth client actually used by GPT v2 has `can_use_web_research = true`;
- GPT v2 imports the schema containing `searchWeb` and `scrapeWebPage`;
- authenticated calls from GPT v2 reach those operations;
- no separate Operations GPT was created or repointed as part of the rollout.
