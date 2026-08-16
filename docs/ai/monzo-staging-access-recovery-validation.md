# Monzo staging Access recovery validation

Validation-only anchor for the guarded recovery operator stacked on PR #299.

This file is intentionally inert. It does not alter runtime code, Cloudflare Access, KV, Workers, DNS, WAF, Monzo provider state, Supabase, staging data or production.

The recovery operator may run only after this exact validation head passes normal CI and only when the PR body contains the exact-SHA one-time recovery marker.

Expected recovery boundary:
- the existing owner-only host Access application must already be present and must verify exactly;
- the exact webhook-path Access application may be created only if absent;
- no Access application or policy may be updated or deleted;
- no Worker deploy, KV write, DNS/WAF change, provider call, Supabase mutation or production action is permitted.
