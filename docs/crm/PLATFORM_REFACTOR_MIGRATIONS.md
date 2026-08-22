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

The next unclaimed migration number after the current stacked lineage is therefore:

`0084`

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
- Q-R: MCP domain contracts and surface, currently expected to need no migration unless implementation proves otherwise;
- S-T: unified GPT profile-bound authorization;
- U: golden-path validation, no migration unless validation exposes a required schema fix.

The first unfinished phase that actually begins after the current `0083` lineage may claim `0084`. Later phases claim the next free number from the then-current repository state, not from the stale planning table.
