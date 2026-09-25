-- 20260924070000_client_fact_provenance.sql
--
-- Phase 6b of the CRM AI architecture: stated facts carry provenance, and a
-- contradiction between sources is surfaced, never resolved silently.
--
-- Two sources state project facts about a client today:
--   * the enquiry form: what the client typed (stated_by = client);
--   * the AI brief: what the model read in the conversation (stated_by =
--     model), with the model id and whether the brief is current.
-- Nothing is stored twice. Provenance is derived live from the rows that own
-- each value, so it cannot drift from them.
--
-- A contradiction is raised only where it can be decided without judgement:
--   * placement: both sources name body areas and share no body-area word;
--   * size: both sources state a measurement and they differ by more than 50%.
-- Anything vaguer stays silent. A raised contradiction becomes an attention
-- conflict (`fact_conflict_placement`, `fact_conflict_size`) and reaches the
-- Today pulse like every other deterministic conflict. Nothing is overwritten.

-- ---------------------------------------------------------------------------
-- 1. Normalisation helpers (pure)
-- ---------------------------------------------------------------------------

-- Body-area words of a placement, without side/position qualifiers.
create function crm_private.fact_placement_terms(p_text text)
returns text[]
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(array_agg(distinct w order by w), '{}'::text[])
  from regexp_split_to_table(lower(coalesce(left(p_text, 200), '')), '[^a-z]+') as w
  where length(w) >= 3
    and w not in (
      'left', 'right', 'upper', 'lower', 'inner', 'outer', 'side', 'front', 'top',
      'bottom', 'and', 'the', 'my', 'near', 'around', 'area', 'part', 'just', 'below',
      'above', 'under', 'over', 'half', 'full', 'small', 'big', 'large', 'piece', 'tattoo',
      'with', 'from', 'across', 'along', 'centre', 'center', 'middle', 'both',
      'maybe', 'either', 'not', 'sure', 'yet', 'somewhere', 'ideally', 'probably', 'about');
$$;

-- First stated measurement in centimetres, or null when none is stated.
create function crm_private.fact_size_cm(p_text text)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $$
  select case m[2]
      when 'mm' then m[1]::numeric / 10
      when 'cm' then m[1]::numeric
      else m[1]::numeric * 2.54
    end
  from (select regexp_match(
          lower(replace(coalesce(left(p_text, 200), ''), ',', '.')),
          '([0-9]{1,3}(?:\.[0-9]{1,2})?)\s*(mm|cm|in|inch|inches|")') as m) x
  where m is not null and m[1]::numeric > 0;
$$;

-- ---------------------------------------------------------------------------
-- 2. Live provenance of stated facts
-- ---------------------------------------------------------------------------

create function crm_private.client_fact_sources(p_artist_id uuid, p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with form as (
    -- The most recent open enquiry is what the client last told the form.
    select e.id, e.reference_number, e.created_at, e.placement, e.approximate_size
    from public.enquiries e
    where e.artist_id = p_artist_id and e.client_id = p_client_id and e.archived_at is null
    order by e.created_at desc
    limit 1
  ),
  brief as (
    select st.brief, st.updated_at, st.provider, st.model,
           st.source_watermark = crm_private.client_ai_watermark(p_artist_id, p_client_id) as current
    from public.client_ai_state st
    where st.artist_id = p_artist_id and st.client_id = p_client_id
  )
  select coalesce(jsonb_agg(c order by c ->> 'key', c ->> 'source'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'key', k.key, 'value', left(k.value, 200), 'source', 'enquiry_form',
      'stated_by', 'client', 'reference', f.reference_number, 'stated_at', f.created_at) as c
    from form f,
    lateral (values ('placement', f.placement), ('size', f.approximate_size)) as k(key, value)
    where nullif(btrim(k.value), '') is not null
    union all
    select jsonb_build_object(
      'key', k.key, 'value', left(k.value, 200), 'source', 'ai_brief',
      'stated_by', 'model',
      'model', b.model, 'current', b.current, 'stated_at', b.updated_at)
    from brief b,
    lateral (values ('placement', b.brief ->> 'placement'),
                    ('size', b.brief ->> 'size')) as k(key, value)
    where nullif(btrim(k.value), '') is not null
  ) s;
$$;

-- ---------------------------------------------------------------------------
-- 3. Decidable contradictions
-- ---------------------------------------------------------------------------

create function crm_private.client_fact_conflicts(p_artist_id uuid, p_client_id uuid)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with src as (
    select s ->> 'key' as key, s ->> 'source' as source, s ->> 'value' as value,
           coalesce((s ->> 'current')::boolean, true) as current
    from jsonb_array_elements(crm_private.client_fact_sources(p_artist_id, p_client_id)) s
  ),
  pairs as (
    select f.key, f.value as form_value, b.value as brief_value
    from src f join src b on b.key = f.key and b.source = 'ai_brief' and b.current
    where f.source = 'enquiry_form'
  )
  select coalesce(array_agg(code order by code), '{}'::text[])
  from (
    select 'fact_conflict_placement'::text as code
    from pairs p
    where p.key = 'placement'
      and cardinality(crm_private.fact_placement_terms(p.form_value)) > 0
      and cardinality(crm_private.fact_placement_terms(p.brief_value)) > 0
      and not (crm_private.fact_placement_terms(p.form_value) && crm_private.fact_placement_terms(p.brief_value))
    union all
    select 'fact_conflict_size'
    from pairs p
    where p.key = 'size'
      and crm_private.fact_size_cm(p.form_value) is not null
      and crm_private.fact_size_cm(p.brief_value) is not null
      and greatest(crm_private.fact_size_cm(p.form_value), crm_private.fact_size_cm(p.brief_value))
          > 1.5 * least(crm_private.fact_size_cm(p.form_value), crm_private.fact_size_cm(p.brief_value))
  ) c;
$$;

-- ---------------------------------------------------------------------------
-- 4. Attention: fact conflicts join the other deterministic conflicts
-- ---------------------------------------------------------------------------

create or replace function crm_private.attention_conflicts(p_artist_id uuid, p_client_id uuid)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(array_agg(code order by code), '{}'::text[])
  from (
    select 'deposit_paid_without_booking'::text as code
    where exists (
      select 1 from public.projects p
      where p.artist_id = p_artist_id and p.client_id = p_client_id and p.archived_at is null
        and p.deposit_status = 'paid' and p.status in ('draft', 'active')
        and not exists (
          select 1 from public.sessions s
          where s.project_id = p.id and s.cancelled_at is null
            and s.appointment_type in ('tattoo_session', 'touch_up')
            and s.status in ('proposed', 'confirmed', 'completed')))
    union all
    select 'consultation_booked_enquiry_new'
    where exists (
      select 1 from public.sessions s
      where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
        and s.appointment_type in ('in_person_consultation', 'video_consultation')
        and s.status in ('proposed', 'confirmed'))
      and exists (
      select 1 from public.enquiries e
      where e.artist_id = p_artist_id and e.client_id = p_client_id and e.archived_at is null
        and e.status = 'new')
    union all
    select 'past_session_unresolved'
    where exists (
      select 1 from public.sessions s
      where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
        and s.status in ('proposed', 'confirmed') and s.end_at < clock_timestamp() - interval '1 day')
    union all
    select 'session_without_project'
    where exists (
      select 1 from public.sessions s
      where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
        and s.appointment_type = 'tattoo_session' and s.project_id is null
        and s.status in ('proposed', 'confirmed', 'completed'))
    union all
    select 'converted_enquiry_without_project'
    where exists (
      select 1 from public.enquiries e
      where e.artist_id = p_artist_id and e.client_id = p_client_id and e.archived_at is null
        and e.status = 'converted')
      and not exists (
      select 1 from public.projects p
      where p.artist_id = p_artist_id and p.client_id = p_client_id and p.archived_at is null)
    union all
    select 'ai_brief_stale'
    where exists (
      select 1 from public.client_ai_state st
      where st.artist_id = p_artist_id and st.client_id = p_client_id
        and st.source_watermark is distinct from crm_private.client_ai_watermark(p_artist_id, p_client_id))
    union all
    -- Phase 6b: a current brief that contradicts what the client typed.
    select unnest(crm_private.client_fact_conflicts(p_artist_id, p_client_id))
  ) c;
$$;

revoke all on function
  crm_private.fact_placement_terms(text),
  crm_private.fact_size_cm(text),
  crm_private.client_fact_sources(uuid, uuid),
  crm_private.client_fact_conflicts(uuid, uuid),
  crm_private.attention_conflicts(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. CRM read: where each stated fact came from
-- ---------------------------------------------------------------------------

create function public.get_client_fact_provenance(p_artist_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_clients');
  if crm_private.client_ai_scope(p_artist_id, p_client_id) is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'sources', crm_private.client_fact_sources(p_artist_id, p_client_id),
    'conflicts', to_jsonb(crm_private.client_fact_conflicts(p_artist_id, p_client_id)));
end;
$$;

revoke all on function public.get_client_fact_provenance(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_client_fact_provenance(uuid, uuid) to authenticated;

comment on function public.get_client_fact_provenance(uuid, uuid) is
  'Phase 6b: each stated project fact with its source (enquiry form or AI brief), who stated it, and decidable contradictions. Read-only; resolves nothing.';
