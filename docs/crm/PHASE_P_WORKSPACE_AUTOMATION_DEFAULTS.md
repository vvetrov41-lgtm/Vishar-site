# Phase P: workspace automation defaults and artist overrides

Phase P keeps the Phase N execution model unchanged. A workspace default is a blueprint, not an executable rule and not an inheritance rule evaluated by the scheduler.

## Write-time expansion

When a workspace default is created or changed, the control plane requires both:

- workspace `manage_integrations` authority, the existing organization-level right behind automation administration;
- artist `manage_automations` authority for every active Artist that would be changed.

The write then expands the blueprint into one ordinary `public.automation_rules` row per current active Artist. If any current Artist is outside the caller's automation authority, the entire write fails rather than applying to a subset.

A new Artist added later inherits nothing automatically. Applying existing defaults is a separate explicit operation that re-checks workspace and Artist authority. This is the same write-time-expansion rule used by workspace team grants in migration `0075`: a workspace becoming larger never silently widens an existing grant.

## Artist overrides

A materialized rule records:

- `workspace_default_id`;
- the workspace default version it last inherited;
- `workspace_override`.

An Artist with `manage_automations` may override its own materialized rule without becoming a workspace administrator. Later workspace edits skip that overridden copy. Clearing the override copies the current workspace default into the same concrete Artist rule and resumes inheritance.

This separation matters for history. The Phase N rule-version trigger still owns executable meaning, pending jobs created under an old concrete rule are withdrawn by the existing tick, and completed jobs retain the action snapshot they actually ran.

## No second scheduler

`public.service_run_automation_tick(integer)` is not changed by Phase P. It still reads only concrete Artist-scoped `automation_rules`. Workspace defaults are never joined at runtime, so there is no cross-Artist read-time inheritance path to secure or debug.

## API boundary

Migration `0083` establishes stable named control-plane contracts but grants none of them to `anon`, `authenticated`, or `service_role`. A later CRM or MCP release must explicitly expose the reviewed operations and extend the strict function ACL inventory at that time. This keeps a schema-foundation release from silently adding browser authority.

No provider, Worker, cron, client communication, or production configuration is changed by Phase P.
