-- Compare tattoo dimensions. A position offset and a total length may appear
-- in the same field. Prefer an explicit total; leave ambiguous values to the
-- artist instead of treating the first number as the size.
create or replace function crm_private.fact_size_cm(p_text text)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $$
  with measurements as (
    select case m[3]
        when 'mm' then m[2]::numeric / 10
        when 'cm' then m[2]::numeric
        else m[2]::numeric * 2.54
      end as cm,
      m[1] is not null or m[4] is not null as is_total
    from regexp_matches(
      lower(replace(coalesce(left(p_text, 200), ''), ',', '.')),
      '(?:(\m(?:overall|total)(?:\s+length)?\s*(?::|of\M|is\M)?)\s*(?:about\s+|approximately\s+)?)?([0-9]{1,3}(?:\.[0-9]{1,2})?)\s*(mm\M|cm\M|inches\M|inch\M|in\M|")\s*(in\s+total\M|overall\M|total\M)?',
      'g'
    ) as parts(m)
    where m[2]::numeric > 0
  )
  select case count(distinct cm) filter (where is_total)
    when 1 then min(cm) filter (where is_total)
    when 0 then case when count(distinct cm) = 1 then min(cm) end
  end
  from measurements;
$$;

-- Keep the exact submitted text in the historical provenance. Both conflict
-- paths use the latest non-archived enquiry and check its status after
-- selection, so an older enquiry cannot replace a closed comparison source.

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
      and (
        select e.status not in ('declined', 'closed')
        from public.enquiries e
        where e.artist_id = p_artist_id and e.client_id = p_client_id and e.archived_at is null
        order by e.created_at desc
        limit 1
      )
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
    join lateral (
      select q.status, q.placement, q.approximate_size
      from public.enquiries q
      where q.artist_id = p_artist_id
        and q.client_id = p_client_id
        and q.archived_at is null
      order by q.created_at desc
      limit 1
    ) e on e.status not in ('declined', 'closed')
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
