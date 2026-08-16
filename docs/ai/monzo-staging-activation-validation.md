# Monzo staging activation validation

This file is an inert validation anchor for the read-only Monzo staging activation preflight.

It contains no runtime code, deployment configuration, provider credentials, account metadata, database migration, Cloudflare resource change or production action.

Validation constraints:

- product head: `505ca4dc29c9b2f40f3388ec0a33d9243b7aa24f`;
- operator head: `5fcd21e31ce24a8a1ed24fdf5191b6f14f30d7c8`;
- production is not targeted;
- retained staging must not be mutated;
- no Monzo provider API call is permitted by the preflight;
- no Worker deploy, KV creation, secret write or Supabase mutation is permitted by the preflight;
- activation readiness remains false until required resources and Cloudflare Access policy are separately proved.

The child pull request containing this file must remain draft and unmerged. Its normal exact-head CI must pass before the exact-SHA preflight marker is added to the pull request body.
