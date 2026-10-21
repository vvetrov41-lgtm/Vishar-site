-- Avoid repeated per-client attention calculation after CTE inlining.
-- Production EXPLAIN showed four call sites; this boundary evaluates once.
-- Preserve the report, ACL, service gate, hourly throttle and timeout settings.

create or replace function crm_private.attention_shadow_report()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with scope as materialized (
    select st.artist_id, st.client_id, st.brief ->> 'stage' as ai_stage,
           st.brief ->> 'waiting_on' as ai_waiting_on,
           crm_private.client_attention(st.artist_id, st.client_id) as a,
           (select n.action_type from public.client_ai_next_actions n
            where n.artist_id = st.artist_id and n.client_id = st.client_id and n.status = 'open'
            order by n.created_at desc limit 1) as ai_action
    from public.client_ai_state st
    join public.clients cl on cl.id = st.client_id and cl.archived_at is null
  ),
  rows as (
    select s.*,
      s.ai_stage is distinct from (s.a ->> 'workflow_stage') as stage_differs,
      s.ai_waiting_on is distinct from (s.a ->> 'waiting_on_candidate') as waiting_differs,
      s.ai_action is not null and not ((s.a -> 'allowed_actions') ? s.ai_action) as action_disallowed
    from scope s
  )
  select jsonb_build_object(
    'clients', count(*),
    'stage_disagreements', count(*) filter (where stage_differs),
    'waiting_on_disagreements', count(*) filter (where waiting_differs),
    'open_ai_actions_disallowed', count(*) filter (where action_disallowed),
    'stage_pairs', coalesce((select jsonb_object_agg(k, n) from (
        select coalesce(ai_stage, 'none') || '->' || coalesce(a ->> 'workflow_stage', 'none') as k, count(*) as n
        from rows where stage_differs group by 1) x), '{}'::jsonb),
    'waiting_pairs', coalesce((select jsonb_object_agg(k, n) from (
        select coalesce(ai_waiting_on, 'none') || '->' || coalesce(a ->> 'waiting_on_candidate', 'none') as k, count(*) as n
        from rows where waiting_differs group by 1) x), '{}'::jsonb),
    'sla_states', coalesce((select jsonb_object_agg(k, n) from (
        select a ->> 'sla_state' as k, count(*) as n from rows group by 1) x), '{}'::jsonb),
    'conflicts', coalesce((select jsonb_object_agg(k, n) from (
        select c as k, count(*) as n from rows, jsonb_array_elements_text(a -> 'conflicts') c group by 1) x), '{}'::jsonb),
    'without_valid_next_step', count(*) filter (where not (a ->> 'has_valid_next_step')::boolean),
    'reply_states', coalesce((select jsonb_object_agg(k, n) from (
        select a ->> 'reply_state' as k, count(*) as n from rows group by 1) x), '{}'::jsonb)
  )
  from rows;
$$;
