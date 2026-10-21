-- Avoid treating multilingual/broad tattoo placement descriptions as contradictory.
-- The source form and AI brief remain unchanged. Only the advisory conflict comparison changes.
-- Keep both provenance and optimized Today paths on the same predicate.
create or replace function crm_private.fact_placement_terms(p_text text)
returns text[]
language sql
immutable
set search_path to 'pg_catalog'
as $function$
  with words as (
    select w
    from regexp_split_to_table(lower(coalesce(left(p_text, 200), '')), '[^[:alpha:]]+') as token(w)
  ), areas as (
    select case
      when w in ('forearm') or w ~ '^предплеч' then 'forearm'
      when w in ('shoulder') or w ~ '^плеч' then 'shoulder'
      when w in ('arm', 'sleeve') or w ~ '^рук' or w ~ 'sleeve$' then 'arm'
      when w in ('elbow') or w ~ '^локт' then 'elbow'
      when w in ('bicep', 'biceps', 'tricep', 'triceps') or w ~ '^(бицеп|трицеп)' then 'upper_arm'
      when w in ('wrist') or w ~ '^запяст' then 'wrist'
      when w in ('hand', 'palm') or w ~ '^(кист|ладон)' then 'hand'
      when w in ('thigh') or w ~ '^бедр' then 'thigh'
      when w in ('calf', 'calves') or w ~ '^(икр|голен)' then 'calf'
      when w in ('knee') or w ~ '^колен' then 'knee'
      when w in ('ankle') or w ~ '^(лодыж|щиколот)' then 'ankle'
      when w in ('foot', 'feet') or w ~ '^(стоп|ступн)' then 'foot'
      when w in ('leg') or w ~ '^ног' then 'leg'
      when w in ('back') or w ~ '^спин' then 'back'
      when w in ('chest', 'pectoral') or w ~ '^груд' then 'chest'
      when w in ('rib', 'ribs') or w ~ '^(ребр|рёбр)' then 'ribs'
      when w in ('stomach', 'abdomen', 'belly') or w ~ '^живот' then 'stomach'
      when w in ('neck') or w ~ '^ше[яеию]' then 'neck'
      when w in ('head') or w ~ '^голов' then 'head'
      else null
    end as area
    from words
  )
  select coalesce(array_agg(distinct area order by area), '{}'::text[])
  from areas where area is not null;
$function$;

-- A broad region is compatible with a specific subregion, but two different
-- specific subregions still conflict. Unrecognized language is not evidence.
create or replace function crm_private.fact_placement_is_conflict(p_form text[], p_brief text[])
returns boolean
language sql
immutable
set search_path to 'pg_catalog'
as $function$
  select coalesce(
    cardinality(p_form) > 0
    and cardinality(p_brief) > 0
    and not (p_form && p_brief)
    and not (
      (p_form <@ array['arm']::text[] and p_brief && array['forearm','shoulder','elbow','upper_arm','wrist']::text[])
      or (p_brief <@ array['arm']::text[] and p_form && array['forearm','shoulder','elbow','upper_arm','wrist']::text[])
      or (p_form <@ array['leg']::text[] and p_brief && array['thigh','calf','knee','ankle','foot']::text[])
      or (p_brief <@ array['leg']::text[] and p_form && array['thigh','calf','knee','ankle','foot']::text[])
    ),
    false
  );
$function$;

revoke all on function crm_private.fact_placement_is_conflict(text[],text[]) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION crm_private.client_fact_conflicts(p_artist_id uuid, p_client_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
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
      and crm_private.fact_placement_is_conflict(
        crm_private.fact_placement_terms(p.form_value),
        crm_private.fact_placement_terms(p.brief_value)
      )
    union all
    select 'fact_conflict_size'
    from pairs p
    where p.key = 'size'
      and crm_private.fact_size_cm(p.form_value) is not null
      and crm_private.fact_size_cm(p.brief_value) is not null
      and greatest(crm_private.fact_size_cm(p.form_value), crm_private.fact_size_cm(p.brief_value))
          > 1.5 * least(crm_private.fact_size_cm(p.form_value), crm_private.fact_size_cm(p.brief_value))
  ) c;
$function$
;

CREATE OR REPLACE FUNCTION crm_private.pulse_fact_conflicts(p_artist_id uuid, p_client_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
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
    where crm_private.fact_placement_is_conflict(p.form_placement_terms, p.brief_placement_terms)

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
$function$
;
