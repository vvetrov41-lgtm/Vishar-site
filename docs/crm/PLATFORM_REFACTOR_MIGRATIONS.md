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

The next unclaimed migration number after the current stacked lineage is therefore:

`0086`

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

The following phases intentionally have **no fixed migration number yet**:

- F-G: Telegram self-service linking and delivery migration;
- (none remaining; Phase U's validation did expose a required fix and claimed `0085`).

Phases Q-R use no migration. Phases S-T claim `0084` on their actual stacked lineage.
Phase U claimed `0085`: its cross-phase golden path found that `list_notifications`
matched only on recipient and never re-derived artist scope, so a revoked
membership kept an artist's notifications in the old recipient's inbox. Any later
schema work claims from `0086` after a fresh check.
