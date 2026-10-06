-- Keep CRM Today on the deterministic attention rules without paying for the
-- full client_attention projection for every active client.
--
-- pulse_items only reads five attention fields: workflow stage, last outbound,
-- SLA state/reason and conflicts. client_attention also computes booking-action
-- readiness, allowed actions, next-step evidence and the full AI stale-brief
-- conflict. On the production artist population that extra work dominates the
-- Today RPC.
--
-- The helpers below preserve the fields Today actually consumes. The AI fact
-- conflict path first materializes cheap candidate comparisons and only hashes
-- the full client AI watermark when a real placement/size contradiction exists.
-- `ai_brief_stale` is deliberately absent here because pulse_items has always
-- filtered that conflict out before rendering Today.

create or replace function crm_private.pulse_fact_conflicts(
  p_artist_id uuid,
  p_client_id uuid
)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with facts as materialized (
    select
      st.source_watermark,
      e.placement as form_placement,
      e.approximate_size as form_size,
      st.brief ->> 'placement' as brief_placement,
      st.brief ->> 'size' as brief_size
    from public.client_ai_state st
    left join lateral (
      select q.placement, q.approximate_size
      from public.enquiries q
      where q.artist_id = p_artist_id
        and q.client_id = p_client_id
        and q.archived_at is null
      order by q.created_at desc
      limit 1
    ) e on true
    where st.artist_id = p_artist_id
      and st.client_id = p_client_id
  ),
  parsed as materialized (
    select
      f.source_watermark,
      crm_private.fact_placement_terms(f.form_placement) as form_placement_terms,
      crm_private.fact_placement_terms(f.brief_placement) as brief_placement_terms,
      crm_private.fact_size_cm(f.form_size) as form_size_cm,
      crm_private.fact_size_cm(f.brief_size) as brief_size_cm
    from facts f
  ),
  candidates as materialized (
    select p.source_watermark, 'fact_conflict_placement'::text as code
    from parsed p
    where cardinality(p.form_placement_terms) > 0
      and cardinality(p.brief_placement_terms) > 0
      and not (p.form_placement_terms && p.brief_placement_terms)

    union all

    select p.source_watermark, 'fact_conflict_size'::text
    from parsed p
    where p.form_size_cm is not null
      and p.brief_size_cm is not null
      and greatest(p.form_size_cm, p.brief_size_cm)
          > 1.5 * least(p.form_size_cm, p.brief_size_cm)
  )
  select coalesce(array_agg(c.code order by c.code), '{}'::text[])
  from candidates c
  -- Preserve client_fact_sources/client_fact_conflicts semantics: a NULL
  -- current flag is treated as current there via coalesce(..., true).
  where coalesce(
    c.source_watermark = crm_private.client_ai_watermark(p_artist_id, p_client_id),
    true
  );
$$;

create or replace function crm_private.pulse_conflicts(
  p_artist_id uuid,
  p_client_id uuid
)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(array_agg(c.code order by c.code), '{}'::text[])
  from (
    select 'deposit_paid_without_booking'::text as code
    where exists (
      select 1
      from public.projects p
      where p.artist_id = p_artist_id
        and p.client_id = p_client_id
        and p.archived_at is null
        and p.deposit_status = 'paid'
        and p.status in ('draft', 'active')
        and not exists (
          select 1
          from public.sessions s
          where s.project_id = p.id
            and s.cancelled_at is null
            and s.appointment_type in ('tattoo_session', 'touch_up')
            and s.status in ('proposed', 'confirmed', 'completed')
        )
    )

    union all

    select 'consultation_booked_enquiry_new'
    where exists (
      select 1
      from public.sessions s
      where s.artist_id = p_artist_id
        and s.client_id = p_client_id
        and s.cancelled_at is null
        and s.appointment_type in ('in_person_consultation', 'video_consultation')
        and s.status in ('proposed', 'confirmed')
    )
      and exists (
        select 1
        from public.enquiries e
        where e.artist_id = p_artist_id
          and e.client_id = p_client_id
          and e.archived_at is null
          and e.status = 'new'
      )

    union all

    select 'past_session_unresolved'
    where exists (
      select 1
      from public.sessions s
      where s.artist_id = p_artist_id
        and s.client_id = p_client_id
        and s.cancelled_at is null
        and s.status in ('proposed', 'confirmed')
        and s.end_at < clock_timestamp() - interval '1 day'
    )

    union all

    select 'session_without_project'
    where exists (
      select 1
      from public.sessions s
      where s.artist_id = p_artist_id
        and s.client_id = p_client_id
        and s.cancelled_at is null
        and s.appointment_type = 'tattoo_session'
        and s.project_id is null
        and s.status in ('proposed', 'confirmed', 'completed')
    )

    union all

    select 'converted_enquiry_without_project'
    where exists (
      select 1
      from public.enquiries e
      where e.artist_id = p_artist_id
        and e.client_id = p_client_id
        and e.archived_at is null
        and e.status = 'converted'
    )
      and not exists (
        select 1
        from public.projects p
        where p.artist_id = p_artist_id
          and p.client_id = p_client_id
          and p.archived_at is null
      )

    union all

    select unnest(crm_private.pulse_fact_conflicts(p_artist_id, p_client_id))
  ) c;
$$;

create or replace function crm_private.pulse_client_attention(
  p_artist_id uuid,
  p_client_id uuid,
  p_now timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'client_id', p_client_id,
    'last_outbound_at', c.last_outbound_at,
    'workflow_stage', s.workflow_stage,
    'sla_state', l.sla_state,
    'sla_reason', l.sla_reason,
    'conflicts', to_jsonb(crm_private.pulse_conflicts(p_artist_id, p_client_id))
  )
  from crm_private.attention_comm_facts(p_artist_id, p_client_id) c,
       crm_private.attention_stage_facts(p_artist_id, p_client_id) s,
       crm_private.attention_sla(
         case when c.reply_state = 'handled' then 'studio' else c.last_speaker end,
         c.reply_state,
         c.last_inbound_at,
         case
           when c.reply_state = 'handled'
             then greatest(c.last_outbound_at, c.handled_at)
           else c.last_outbound_at
         end,
         case
           when exists (
             select 1
             from public.sessions fs
             where fs.artist_id = p_artist_id
               and fs.client_id = p_client_id
               and fs.status = 'confirmed'
               and fs.cancelled_at is null
               and fs.end_at >= coalesce(p_now, clock_timestamp())
           )
             and s.workflow_stage not in ('booked', 'aftercare', 'dormant')
             then 'booked'
           else s.workflow_stage
         end,
         coalesce(p_now, clock_timestamp())
       ) l;
$$;

-- Replace exactly the one full-attention call in pulse_items. Fail closed if
-- its current definition has drifted instead of silently rewriting something
-- unexpected. This avoids copying the large pulse_items body into a migration.
do $migration$
declare
  v_definition text;
  v_needle constant text :=
    'crm_private.client_attention(p_artist_id, ac.client_id, (select t from now_))';
  v_replacement constant text :=
    'crm_private.pulse_client_attention(p_artist_id, ac.client_id, (select t from now_))';
  v_occurrences integer;
begin
  v_definition := pg_get_functiondef(
    'crm_private.pulse_items(uuid,boolean,boolean,timestamptz)'::regprocedure
  );

  v_occurrences :=
    (length(v_definition) - length(replace(v_definition, v_needle, '')))
    / length(v_needle);

  if v_occurrences <> 1 then
    raise exception
      'today pulse fast-path expected exactly one client_attention call, found %',
      v_occurrences;
  end if;

  execute replace(v_definition, v_needle, v_replacement);
end
$migration$;

revoke all on function crm_private.pulse_fact_conflicts(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_conflicts(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_client_attention(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
