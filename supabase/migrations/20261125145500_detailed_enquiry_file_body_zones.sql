-- Extend existing image body-area tags with region-qualified placement keys.
-- Existing broad tags, permission checks, audit, storage and the nine-tag limit remain unchanged.
CREATE OR REPLACE FUNCTION crm_private.enquiry_v2_region_keys_valid(p_keys text[])
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'crm_private'
AS $function$
  with regions as (
    select value as r from jsonb_array_elements(crm_private.enquiry_v2_catalogue()->'regions')
  ), placements as (
    select r, p from regions cross join lateral jsonb_array_elements(r->'placements') p
    where p->>'key' <> 'other'
  ), zones as (
    select r->>'key' as key, r->>'label' as label from regions
    union all
    select (r->>'key')||':'||(p->>'key'), (r->>'label')||': '||(p->>'label') from placements
    union all
    select (r->>'key')||':'||(p->>'key')||':'||v.variant,
      (r->>'label')||': '||(p->>'label')||' · '||v.label
    from placements cross join (values
      ('upper','Upper half · wraparound'),('lower','Lower half · wraparound'),
      ('outer','Outer side · full length'),('inner','Inner side · full length')
    ) v(variant,label)
    where p->>'key' in ('half_sleeve','half_leg_sleeve')
  )
  select p_keys is not null
    and cardinality(p_keys) <= (crm_private.enquiry_v2_catalogue() #>> '{limits,maxAreas}')::integer
    and cardinality(p_keys) = (select count(distinct k) from unnest(p_keys) k)
    and not exists (select 1 from unnest(p_keys) k where not exists (select 1 from zones z where z.key=k));
$function$;

CREATE OR REPLACE FUNCTION crm_private.enquiry_v2_region_labels(p_keys text[])
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'crm_private'
AS $function$
  with regions as (
    select value as r from jsonb_array_elements(crm_private.enquiry_v2_catalogue()->'regions')
  ), placements as (
    select r, p from regions cross join lateral jsonb_array_elements(r->'placements') p
    where p->>'key' <> 'other'
  ), zones as (
    select r->>'key' as key, r->>'label' as label from regions
    union all
    select (r->>'key')||':'||(p->>'key'), (r->>'label')||': '||(p->>'label') from placements
    union all
    select (r->>'key')||':'||(p->>'key')||':'||v.variant,
      (r->>'label')||': '||(p->>'label')||' · '||v.label
    from placements cross join (values
      ('upper','Upper half · wraparound'),('lower','Lower half · wraparound'),
      ('outer','Outer side · full length'),('inner','Inner side · full length')
    ) v(variant,label)
    where p->>'key' in ('half_sleeve','half_leg_sleeve')
  )
  select coalesce(jsonb_agg(z.label order by u.n), '[]'::jsonb)
  from unnest(coalesce(p_keys, '{}')) with ordinality u(k,n)
  join zones z on z.key=u.k;
$function$;

comment on column public.enquiry_files.body_areas is 'Catalogue body area or region:placement[:half coverage] keys, assigned by staff. Existing broad keys remain valid.';
