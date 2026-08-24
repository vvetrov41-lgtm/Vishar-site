# Platform refactor migration allocation

Status: authoritative migration-number ledger for the unfinished platform refactor.

This file supersedes the migration-number column in `docs/crm/PLATFORM_REFACTOR.md` section 6 wherever that older roadmap assigns a number to a phase that has not started yet. The phase descriptions and ordering rationale in the architecture document remain valid; only stale future migration reservations are overridden here.

## Claimed numbers

| Migration | Owner | State |
| --- | --- | --- |
| `0074` | Phase B, capability registry | claimed in PR #382 |
| `0075` | Phase C, workspaces | claimed in PR #382 |
| `0076` | Phase D, integration ownership and assignment | claimed in PR #382 |
| `0077` | Phases K-M, internal notifications and follow-up sweep | claimed in PR #382 |
| `0078` | Phase H, dynamic booking source registry | claimed in PR #383 |
| `0079` | Phases I-J, hosted forms and external websites | claimed on `agent/platform-hosted-booking-forms` |
| `0080` | Phases I-J, booking-source list scope hardening | claimed on `agent/platform-hosted-booking-forms` |
| `0081` | Phase N, automation engine foundation | claimed on `agent/platform-automation-engine` |
| `0082` | Phase O, message templates and the consent/suppression gate | claimed on `agent/platform-message-templates` |
| `0083` | Phase P, workspace automation defaults and artist overrides | claimed on `agent/platform-workspace-automation-defaults` |
| `0084` | Phases S-T, unified GPT profile-bound authorization | claimed on `agent/platform-unified-gpt` |
| `0085` | Phase U, notification scope re-checked on revocation | claimed on `agent/platform-golden-paths` |
| `0086` | Phases F-G, Telegram self-service destinations and delivery foundation | claimed in PR #391 |
| `0087` | Control plane, artist/workspace lifecycle | claimed in PR #394 |
| `0088` | Control plane, read surfaces | claimed in PR #394 |
| `0089` | Control plane, governance hardening | claimed in PR #394 |
| `0090` | Control plane, ownership-transfer boundary hardening | claimed in PR #394 |
| `0091` | Telegram artist delivery observability | claimed on private CRM lineage |
| `0092` | Automation client-message action | claimed on private CRM lineage |
| `0093` | Client lifecycle automation | claimed on private CRM lineage |
| `0094` | Client lifecycle control plane | claimed on private CRM lineage |
| `0095` | Client lifecycle client-archive fix | claimed on private CRM lineage |
| `0096` | Client lifecycle scheduling integrity | claimed on private CRM lineage |
| `0097` | Lifecycle Automation v1 production activation | claimed in PR #414 |
| `0098` | Appointment client-action capability foundation | claimed on `agent/appointment-client-actions-foundation` |

The next unclaimed migration number after the current stacked lineage is therefore:

`0099`

## Allocation rule for unfinished phases

Do not pre-assign fixed migration numbers to Telegram self-service, automations, templates, MCP/GPT support, or any other unfinished phase.

Before an unfinished phase creates its first migration:

1. fresh-check the exact relevant branch HEAD and all open stacked workstreams;
2. fresh-check the production Supabase migration head;
3. enumerate migration filenames already present in every active ancestor/stacked branch that the new work depends on;
4. claim the lowest next unused forward-only migration number on that actual lineage;
5. record the claim in this ledger in the same workstream that introduces the migration.

This avoids two failure modes present in the original roadmap table: two future phases claiming the same number, and a blocked/deferred phase reserving a lower number that later has to be inserted behind already-applied production migrations.

## Current unfinished phases

The platform-refactor roadmap has no other phase waiting for an initial migration number. Phase F-G now claims `0086`; later fixes use the next free number after a fresh check.

The control-plane workstream claims `0087` through `0090` on the lineage whose tip
is `agent/platform-telegram-self-service`. Production Supabase
(`vfjexhfdbrjmuxfdvbdx`) was fresh-checked at `0086_telegram_self_service`
before the claims. `0087` adds the artist and workspace lifecycle RPCs, the
shared capability derivation and the one-shot artist seat; `0088` adds the
control-plane reads and opens the two workspace-automation calls artist
onboarding needs. See `docs/crm/NEW_ARTIST_ONBOARDING.md`. `0089` closes the
governance gaps an independent review found in that first pass: a scoped people
directory, workspace owner invariants and a deliberate ownership transfer, an
eligibility check before the one-shot artist seat is spent, and two server-
authoritative reads that let the artist open their own onboarding page and the
interface stop deriving control-plane visibility from `CrmRole`. `0090` closes
the final ownership-transfer boundary found in the second review: only a sitting
active workspace owner may transfer that workspace, so installation-wide owner
authority can no longer create an extra owner while emitting a false
`from_profile_id`.

Phases Q-R use no migration. Phases S-T claim `0084` on their actual stacked lineage.
Phase U claimed `0085`: its cross-phase golden path found that `list_notifications`
matched only on recipient and never re-derived artist scope, so a revoked
membership kept an artist's notifications in the old recipient's inbox. Phase
F-G claims `0086` for the private Telegram destination registry, single-use
linking sessions and external-notification delivery state. Its runtime and
production activation contract is documented in `docs/crm/TELEGRAM_SELF_SERVICE.md`.

The client lifecycle workstream claims `0092` through `0095`, and its
scheduling-integrity restack claims `0096`. Lifecycle Automation v1 claims
`0097`: the first configuration that makes that engine do something, rather
than more machinery. It ships, per active artist, a 72-hour and a 24-hour
tattoo-session reminder plus a 24-hour consultation check-in (both
`in_person_consultation` and `video_consultation`, which are one rule each
because a lifecycle rule is conditioned on exactly one appointment type), the
three service templates those rules select, and nothing else. It deliberately
ships no 72-hour consultation reminder and leaves `touch_up` unconfigured.
Because a job materialises only from a new `appointment.scheduled` event and
history is never backfilled, applying it cannot send an email and does not
enrol already-booked clients.

Appointment client actions claim `0098`. That migration is deliberately an inert
foundation: it stores non-terminal client responses separately from internal
appointment status, adds server-only one-time capabilities bound to the exact
appointment version, exposes only narrow backend resolve/apply RPCs, and keeps
reschedule as a request while preserving the existing Calendar cancellation
path for an explicit client cancel. No `0097` template is changed and no token
is issued merely by applying `0098`; reminder-link activation remains a separate
workstream after review. Any later schema work claims from `0099` after a fresh
check.
