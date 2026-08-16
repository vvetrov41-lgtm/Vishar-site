# Monzo staging Access provisioning validation

Validation-only anchor for the guarded Monzo staging Access provisioning operator.

Exact operator base: `839c079bfdd02cbee3be709e3c7182c2adbef2ed`.

This file contains no runtime configuration, Cloudflare identifier, credential, policy ID, provider data or deployment instruction.

The associated guarded operation is limited to creating, only when absent:

- the exact owner-only self-hosted Access application for `monzo-staging.vishartattoo.com`;
- the exact more-specific self-hosted Access application for `monzo-staging.vishartattoo.com/webhooks/monzo/*`, with Bypass limited to that webhook path.

Existing Access applications and policies must never be updated or deleted by this operator. Production is not targeted. No Worker deploy, KV write, DNS/WAF change, provider call or Supabase mutation is authorised.
