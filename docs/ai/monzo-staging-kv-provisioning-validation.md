# Monzo staging KV provisioning validation

This file is an inert validation anchor for the guarded Monzo staging KV provisioning operator.

It contains no runtime code, deployment configuration, credential, KV identifier, provider metadata, database migration, Cloudflare resource mutation or production action.

Validation constraints:

- product head: `5fc45508be2bcda2fb573254cdbfb430a57b3cc6`;
- operator head: `78e01c16ae7479ffcf2c0ed789f599d8f8b83f2e`;
- production is not targeted;
- retained Supabase staging must not be mutated;
- no Worker deploy, DNS/Access/WAF change, Monzo provider call or KV value write is permitted;
- provisioning may create only three exact empty Monzo staging KV namespaces after normal exact-head CI is green and the exact-SHA marker is explicitly added;
- the child pull request must remain draft and unmerged.
