# Rollout: Phases 3–6b

Every step goes through the canonical paths:
- private production release for the database and CRM Pages;
- `release/private-crm-rc<PR>-tattooai-worker` for the Worker.

Each release runs from an exact trunk SHA with green CI on that SHA. All
readback queries below are read-only (`begin read only; … rollback;`).

## Order and migration versions

| Step | PR | Migration | Switches after release |
|---|---|---|---|
| Phase 3 code | #890 | `20260924040000` | none (all off) |
| Phase 3 activation | enable PR | `20260924045000` (data) | `deterministic_state = true`, Worker `CRM_AGENT_CONTRACT=v2` |
| Phase 4 code | #891 | `20260924050000` | none (`today_pulse = false`, `CRM_TODAY_PULSE_ENABLED` unset) |
| Phase 4 activation | enable PR | `20260924055000` (data) | `today_pulse = true`, scheduler `CRM_TODAY_PULSE_ENABLED=true` |
| Phase 5 | #892 | `20260924060000` | none; the suggestion chip is read-only |
| Phase 6b | #894 | `20260924070000` | none; fact conflicts join attention |

Every new migration must be newer than every migration on the base, which
fixes this order. The activation migrations use the half-step versions so
that they fit between the code migrations.

## Gate before Phase 3 activation

1. All 32 briefs are fresh; the Phase 2 shadow report is compared with the
   baseline:
   - stage and waiting_on disagreements;
   - `open_ai_actions_disallowed` = 0;
   - SLA overdue;
   - `without_valid_next_step`.
2. Synthetic v2 eval on Llama (`contract: 'v2'` variant). Schema-valid rate
   and semantic checks must be no worse than v1 on the same fixtures.

## Readback

### Phase 3 code released (switch off)

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 3;
select deterministic_state from crm_private.crm_agent_config;                 -- false
select proname from pg_proc where proname in (
  'service_record_client_reply_state','service_contract_rule_summary',
  'client_ai_state_deterministic_fields','client_ai_next_action_allowed');     -- 4 rows
select has_function_privilege('service_role','crm_private.client_ai_context(uuid,uuid)','execute'); -- false
```

### Phase 3 activated

```sql
select deterministic_state from crm_private.crm_agent_config;                 -- true
-- New briefs carry the deterministic stage / waiting side:
select count(*) filter (where (st.brief->>'stage') is distinct from (crm_private.client_attention(st.artist_id, st.client_id)->>'workflow_stage')) as stage_diff,
       count(*) filter (where (st.brief->>'waiting_on') is distinct from (crm_private.client_attention(st.artist_id, st.client_id)->>'waiting_on_candidate')) as waiting_diff
from public.client_ai_state st where st.updated_at > '<activation time>';     -- both 0
-- Rule interventions (disallowed actions superseded):
select public.service_contract_rule_summary(24);  -- as service backend
-- v2 runs succeed:
select r.prompt_version, r.outcome, count(*) from crm_private.ai_runs r
where r.created_at > '<activation time>' and r.job_kind = 'client_state' group by 1, 2;
```

### Phase 4 / 5 / 6b

```sql
select today_pulse from crm_private.crm_agent_config;
select public.get_today_pulse('<artist id>');                -- as an operator
select crm_private.client_fact_conflicts(artist_id, client_id), count(*)
from public.client_ai_state group by 1;                      -- fact conflicts, content-free
```

## Rollback

- **Phase 3 activation.**
  - Remove `CRM_AGENT_CONTRACT` in a Worker release: the v1 contract returns immediately.
  - Set `deterministic_state = false` in a later migration.
  - No row is lost, and briefs written meanwhile are valid under both contracts.
- **Phase 4 activation.**
  - Set `today_pulse = false` in a migration and unset `CRM_TODAY_PULSE_ENABLED`.
  - The CRM falls back to the existing Today view, and Telegram `/today` to the digest.
- **Phase 5 / 6b.** Read-only surfaces. Rollback is a code revert and a release; there is no data to undo.
- **Code migrations** are additive: new functions, a column, triggers that no-op while their switch is off. None drops or rewrites existing data.
