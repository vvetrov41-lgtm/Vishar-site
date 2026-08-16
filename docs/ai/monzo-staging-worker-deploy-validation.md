# Monzo staging Worker deploy validation

Validation-only anchor for the guarded dormant Monzo staging Worker deploy operator stacked on PR #301.

This file is intentionally inert. It does not change runtime code, Cloudflare Access, KV, Workers, DNS, WAF, Monzo provider state, Supabase, retained staging data or production.

The deploy operator may run only after this exact validation head passes normal CI and only while the PR body contains its exact-SHA one-time deploy marker.

Expected deploy boundary:
- retained Supabase staging is inspected read-only before upload;
- the exact three existing Monzo staging KV namespaces and both exact Access applications must reverify;
- the initial Worker must still be absent before upload;
- no Monzo OAuth credentials or Supabase backend secret are installed;
- reconciliation remains disabled;
- only the dormant staging Worker, exact Custom Domain/DNS mapping and generated Worker encryption secret may be created;
- production is never targeted.
