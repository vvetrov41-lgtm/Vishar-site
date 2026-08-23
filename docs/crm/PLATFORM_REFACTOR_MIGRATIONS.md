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

The next unclaimed migration number after the current stacked lineage is therefore:

`0090`

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

The platform-refactor roadmap has no other phase waiting for an initial migration number. Phase F-G now claims `0086`; later fixes, if validation exposes any, claim from `0090` after a fresh check.

The control-plane workstream claims `0087` and `0088` on the lineage whose tip
is `agent/platform-telegram-self-service`. Production Supabase
(`vfjexhfdbrjmuxfdvbdx`) was fresh-checked at `0086_telegram_self_service`
before the claim, and no other active branch holds either number. `0087` adds
the artist and workspace lifecycle RPCs, the shared capability derivation and
the one-shot artist seat; `0088` adds the control-plane reads and opens the two
workspace-automation calls artist onboarding needs. See
`docs/crm/NEW_ARTIST_ONBOARDING.md`. `0089` closes the governance gaps an
independent review found in that first pass: a scoped people directory, so the
control plane stops depending on the legacy global owner; workspace owner
invariants and a deliberate ownership transfer; an eligibility check before the
one-shot artist seat is spent; and two server-authoritative reads that let the
artist open their own onboarding page and the interface stop deriving control-
plane visibility from `CrmRole`. Any later schema work claims from `0090` after
a fresh check.

Phases Q-R use no migration. Phases S-T claim `0084` on their actual stacked lineage.
Phase U claimed `0085`: its cross-phase golden path found that `list_notifications`
matched only on recipient and never re-derived artist scope, so a revoked
membership kept an artist's notifications in the old recipient's inbox. Phase
F-G claims `0086` for the private Telegram destination registry, single-use
linking sessions and external-notification delivery state. Its runtime and
production activation contract is documented in `docs/crm/TELEGRAM_SELF_SERVICE.md`.
Any later schema work claims from `0090` after a fresh check.
