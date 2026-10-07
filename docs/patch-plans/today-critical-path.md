# Today critical path, 7 October 2026

Bounded performance repair; no new operator action or trust boundary. Operator
parity remains available through the existing Today/read and acknowledgement
contracts. No Telegram or Worker mutation is part of the release.

## Observed production

Canonical CRM branch: `agent/platform-telegram-self-service`, initially
`1280a0214bc7bdcd36ad877e54ad1a6b1238ab8b`. Public Pages has that SHA, but
operator Pages still has `94a3c2d430c36a26b01354729130405cbbcb7504` from 2 October.
The previous progressive frontend release never reached the operator host.

The newer frontend still waits for five reads followed by client-name resolution.
`useAsync` retains nothing across route unmounts. Artist-scope initialization
starts with all artists and can issue a second full load after selection resolves.

Fresh production EXPLAIN: items 858 ms; summary 263 ms. Inlined items plan:
695 ms execution, 42 ms planning; attention assembly 516 ms and conversation
attention 98 ms. 51 active clients cause 51 communication/stage fact reads. The complete owner
all-active-artist items plus summaries probe takes 1520 ms, so a single-artist
items-only benchmark understates actual RPC work.

## Changes and boundaries

1. Independent pulse, named schedule, navigation, supplemental and Gmail resources.
   Never show empty attention until the complete browser fallback is ready.
   Reply links await their navigation enrichment; failures cannot hide pulse.
2. In-memory, bounded snapshot cache keyed by API instance, profile, capabilities,
   artist and day. Deduplicate in-flight reads; stale snapshots revalidate, expire
   after two minutes, and disappear on authentication changes. No browser storage.
3. Wait for artist scope before querying, preventing all-artists then selected-artist
   duplication. Preserve RLS and all existing RPC authorization.
4. Numeric User Timing marks and explicit PostHog timings with fixed enum stages
   and capped 100 ms buckets. No identity, URL, customer data or response logging.
5. Evaluate a set-based communication-facts path against every existing active
   production client read-only before an ordered migration. Preserve booking,
   operator mark/acknowledgement, future confirmed appointment and conflict rules.
6. Exact-head CI, canonical recheck, narrow CRM deployment on both hosts. DB changes
   only through the database-only exact-SHA release with dry-run/drift checks.

## Acceptance

Delay each unrelated request indefinitely and prove pulse still renders. Delay
pulse and prove the named schedule renders. Return from another route and prove
cached Today is visible immediately. Verify scope/auth cache boundaries and stale
refresh failure. Compare old/new attention JSON at fixed time and test denied roles.
Read back exact Pages SHA on both hosts and retain Access on the operator host.
Record real DB timings separately from local rendered tests; browser production
paint timings require a usable authenticated browser or actual timing telemetry.
