# Exact-head and stacked-PR workflow

Vishar-site uses stacked draft PRs extensively. The most common navigation failure is reading a correct symbol from the wrong revision.

## Required preflight

Before investigating implementation associated with a PR:

1. Read current PR metadata from GitHub.
2. Record the head branch and exact head SHA.
3. Record the base branch and exact base SHA.
4. Determine whether the base branch is itself an open draft PR.
5. Repeat upward only as far as needed to understand the dependency being investigated.
6. Fetch/checkout the exact target SHA.
7. Run `git rev-parse HEAD` and compare it byte-for-byte with the expected SHA.
8. Run `git status --short` and note whether the checkout is clean.

Do not start implementation analysis until step 7 passes.

## Preferred checkout commands

When a full checkout is available:

```bash
git fetch --all --prune
git checkout --detach <exact-head-sha>
git rev-parse HEAD
git status --short
```

If the task requires editing, create a new task branch from the exact target instead of editing the existing feature branch:

```bash
git switch -c agent/<task-name> <exact-head-sha>
```

Never silently commit unrelated working-tree changes.

## Compare the correct range

For a normal PR, compare its exact base and head:

```bash
git diff --stat <base-sha>...<head-sha>
git diff <base-sha>...<head-sha> -- <relevant-paths>
```

For a stacked PR, `main...head` often includes all parent work and obscures the PR-specific change. Prefer the exact parent PR head as the comparison base when that is the actual GitHub base.

## Evidence header

Every substantial PR investigation should make the checked scope explicit:

```text
Repository: vvetrov41-lgtm/Vishar-site
PR: #<number>
Head branch: <branch>
Head SHA: <sha>
Base branch: <branch>
Base SHA: <sha>
Checkout verified: yes/no
```

For a cross-repository investigation, produce one header per repository.

## Search after checkout

Once the ref is proven, prefer local/cloud repository search:

```bash
rg -n "<symbol-or-contract>" .
git grep -n "<symbol-or-contract>" <exact-head-sha>
git log -S"<symbol>" --all -- <path>
git log -G"<regex>" --all -- <path>
git show <sha>:<path>
```

Use GitHub file-by-file fetching only when a full checkout is unavailable or when GitHub metadata itself is the subject of the investigation.

## Migration rule

Finding the first SQL definition is not enough. After locating a function/table/policy, search all later migrations for:

- `create or replace function`;
- `drop function`;
- `alter`;
- `grant`;
- `revoke`;
- policy changes;
- trigger changes;
- enum/constraint changes affecting the same workflow.

The final effective behavior is the ordered result of all migrations at the exact head.

## CI evidence rule

A workflow result is valid evidence only when its checked SHA matches the target SHA or when a purpose-built validation harness explicitly verifies and tests that target SHA.

Superseded green runs are historical evidence only. A successful run on `main`, a parent stack head, or an older head must not be reported as validation of the current PR.

## Write and deployment boundary

Investigation does not imply permission to mutate anything.

Unless the task explicitly authorizes it:

- do not modify an existing PR branch;
- do not merge or mark a draft Ready;
- do not deploy production;
- do not mutate Supabase/Cloudflare/staging state;
- do not create or rotate secrets;
- do not run destructive database commands.

When implementation is authorized, prefer a separate branch or the explicitly named task branch and keep the diff bounded to the requested scope.

## Parallel work

Parallel engineering tasks should use separate cloud checkouts, branches, or worktrees. Never assume two agents share the same local state. Each agent must independently verify its own `HEAD` before analysis or writes.