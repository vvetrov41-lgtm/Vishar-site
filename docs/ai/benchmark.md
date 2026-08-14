# AI navigation benchmark

This benchmark determines whether the repository-native navigation layer meaningfully reduces agent overhead. Do not invent timing or tool-call numbers. Record observed runs only.

## Goal

Compare the same engineering investigation performed:

- with generic GitHub/file-by-file discovery;
- with the repository-native `AGENTS.md`, `docs/ai/`, skill, helper scripts, and a full cloud/local checkout.

Sourcebot or another indexing service should be reconsidered only if important multi-branch/cross-repository navigation problems remain after this benchmark.

## Metrics

For each run record:

- target repository and exact SHA;
- target PR/stack;
- wall-clock investigation time when observable;
- GitHub metadata calls;
- code search/navigation calls;
- files opened/read substantially;
- manual branch-discovery steps;
- incorrect-ref attempts;
- required functions/security boundaries missed on the first pass;
- corrections needed after the first answer;
- whether a second repository was required;
- final answer correctness against a prepared evidence checklist.

Do not treat token count alone as the primary metric. Correct ref selection and coverage of security boundaries matter more.

## Scenario 1: booking intake and artist-specific notification

Trace the current implementation equivalent of:

```text
handleEnquiryIntake
  -> trusted enquiry intake
  -> file manifests/private Storage
  -> finalization
  -> outbox
  -> backend route resolution
  -> provider binding
  -> notification
  -> outbox acknowledgement
```

Prepared evidence checklist should include at least:

- exact Origin validation;
- server-controlled booking source/form version;
- database artist resolution;
- no browser-controlled artist/provider routing;
- narrow Worker RPC allow-list;
- private file persistence/finalization;
- backend-only outbox routing;
- provider credential custody outside DB-safe metadata;
- notification failure cannot undo a durable enquiry;
- relevant tests/migrations at the same ref.

## Scenario 2: appointment reschedule to Google Calendar

Trace the current implementation equivalent of:

```text
appointment reschedule
  -> calendar version
  -> outbox enqueue
  -> claim/lease
  -> provider route
  -> Google Calendar operation
  -> acknowledgement
  -> retry/dead-letter/stale-result behavior
```

Prepared evidence checklist should include:

- authorized appointment mutation;
- versioned queueing;
- `SKIP LOCKED`/current concurrency protection;
- lease ownership;
- minimum safe event projection;
- OAuth token custody;
- stale response protection;
- retry/dead-letter behavior;
- Supabase appointment remains authoritative.

## Scenario 3: `kisa` to Vishar-site cross-repository booking

At current exact heads, trace:

```text
kisa /api/booking
  -> CRM delivery producer contract
  -> Vishar-site receiving intake
  -> trusted source resolution
  -> Kristina artist ownership
  -> durable intake/outbox
  -> artist-specific integration route
```

Check both sides for endpoint, method, Origin, multipart field names, file constraints, idempotency, privacy version, response reference field, and routing values deliberately absent from the producer.

## Success thresholds

The repository-native layer is considered useful if repeated runs show all of the following:

- at least 30% fewer navigation/search calls than the generic GitHub workflow;
- exact target SHA verified before implementation claims in every benchmark run;
- zero conclusions based on the wrong branch;
- all prepared security boundaries found or explicitly reported as unverifiable;
- materially less user-provided handoff context required for a fresh agent/chat;
- cross-repository producer/consumer contract can be reconstructed without the user manually naming implementation files.

A stronger target is 40% fewer navigation calls on branch-heavy investigations.

## Sourcebot reconsideration trigger

Reconsider Sourcebot or another index only if, after these repository-native improvements, one or both remain persistent bottlenecks:

1. agents repeatedly need expensive discovery across many active revisions of the same repository;
2. agents repeatedly need one search spanning multiple repositories and the contract docs/full checkouts do not reduce that cost enough.

If a normal Codex cloud checkout plus `rg` is already fast for one exact head, do not add infrastructure merely to replace that search.

## Benchmark log template

```text
Date:
Scenario:
Agent/model:
Repository/ref(s):
PR/stack:

GitHub metadata calls:
Search/navigation calls:
Files read:
Incorrect-ref attempts:
Missed checklist items on first pass:
Wall-clock time (if observable):

Result correctness:
Main friction:
Would a cross-repo/multi-revision index materially help? yes/no + why
```

Keep raw benchmark observations out of architectural claims until at least two comparable runs exist.