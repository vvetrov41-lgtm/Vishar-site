---
name: vishar-code-navigation
description: Navigate and investigate Vishar-site engineering code safely across stacked PRs, Workers, Supabase migrations, CRM, outbox integrations, Calendar, GPT actions, and related repositories. Use for code tracing, RPC investigation, security review, CI diagnosis, branch/ref validation, migration history, or cross-repository contract analysis. Do not use for GEO/AEO research or ordinary copy/site-content work.
---

# Vishar Code Navigation

Use this skill when the task requires understanding or diagnosing implementation in Vishar-site or a connected code flow.

This repository is branch-heavy. Correct revision selection is part of correctness.

## 1. Prove the target before implementation search

Read `docs/ai/branch-workflow.md`.

If the task references a PR, branch, validation run, or recent feature:

1. resolve current PR metadata from GitHub;
2. record exact head SHA and base SHA;
3. identify stacked parent when relevant;
4. checkout the exact target SHA;
5. run `git rev-parse HEAD`;
6. do not make implementation claims until the SHA matches.

If the user supplied an old SHA, verify whether it is still the requested target instead of silently substituting a newer one.

## 2. Prefer repository-native search

After checkout, search the full repository before fetching individual files through GitHub:

```bash
rg -n "<symbol|error|contract>" .
git grep -n "<symbol>" HEAD
```

Use GitHub primarily for PR metadata, heads/bases, reviews, Actions, and cross-repository discovery.

Read `docs/ai/repository-map.md` to choose the first search areas.

## 3. RPC tracing procedure

For every database RPC under investigation:

1. find all callers;
2. find all migration occurrences;
3. determine the final effective definition at the target head;
4. find `GRANT` and `REVOKE` history;
5. inspect `SECURITY DEFINER`, `search_path`, role/service/artist checks;
6. identify RLS interaction and privileged bypasses;
7. find positive and denial tests;
8. inspect returned fields for boundary leakage.

Use:

```bash
scripts/ai/trace-rpc.sh <rpc_name>
scripts/ai/migration-history.sh <rpc_name>
```

Do not stop at the first matching migration.

## 4. Worker and booking tracing procedure

For public intake or provider flows, trace in order:

```text
entry/router
  -> method/path
  -> exact Origin
  -> body/file validation
  -> browser-controlled values
  -> server-controlled configuration
  -> privileged RPC/storage call
  -> durable state boundary
  -> outbox
  -> provider route
  -> credential custody
  -> provider call
  -> acknowledgement/retry
```

For booking/artist routing, explicitly prove that browser data cannot authoritatively choose artist, booking source key, integration key, provider account, Telegram destination, Calendar account, or payment destination.

Read `docs/ai/security-boundaries.md`.

## 5. Migration tracing procedure

When a symbol is defined in SQL, search every later migration for the symbol and related object. A later migration may replace a function, change a grant, add a trigger, harden a constraint, or alter an enum/policy.

Report the effective behavior at the exact target head, not merely the earliest implementation.

## 6. Outbox and Calendar procedure

For outbox/Calendar work, always trace:

- business mutation;
- version/dedupe key;
- enqueue;
- claim/lease;
- concurrency protection;
- safe projection;
- artist/provider route;
- secret/token custody;
- provider operation;
- acknowledgement;
- stale-result behavior;
- retry/dead letter;
- activity/audit evidence.

Do not describe Google Calendar as authoritative unless current code proves that design changed. In the current architecture, verify Supabase appointment authority rather than assuming it.

## 7. Cross-repository procedure

Read `docs/ai/cross-repo-contracts.md`.

Resolve and verify each repository at its own exact head. For `kisa` booking work, compare the public producer contract with the Vishar-site consumer contract, including values deliberately absent from the producer.

Never combine a current Vishar-site ref with a remembered `kisa` ref.

## 8. CI diagnosis procedure

Before diagnosing a failing run:

1. verify run SHA against target SHA;
2. ignore unrelated/superseded runs for current validation claims;
3. locate the first causal failure;
4. classify the failing layer;
5. change only the proven layer;
6. never weaken production ACL/RLS/security to satisfy a test harness.

## 9. Mutation boundary

Investigation permission is not write permission.

Unless explicitly requested:

- do not modify existing PR branches;
- do not merge or mark Ready;
- do not deploy production;
- do not mutate staging, Cloudflare, Supabase, external accounts, or secrets.

When implementation is authorized, use the explicitly requested branch or a new bounded task branch from the verified target.

## 10. Required output

For substantial engineering investigations, report:

- repository and exact ref;
- PR/base/head relationship;
- observed implementation chain;
- security/authorization boundaries checked;
- migrations/tests/CI evidence;
- unknowns or unverified external state;
- whether any mutation was performed.

Do not dump a long list of files without explaining the causal chain.