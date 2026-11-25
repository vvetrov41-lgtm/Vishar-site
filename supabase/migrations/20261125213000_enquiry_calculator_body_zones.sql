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

-- Preserve client estimate and store operator coverage separately. No price or finance write is accepted.
create or replace function crm_private.clean_enquiry_calculator_selection(p_selection jsonb, p_areas jsonb)
returns jsonb language plpgsql immutable set search_path = pg_catalog as $$
declare a jsonb; matched jsonb; k text; v text; out_area jsonb; result jsonb := '[]'::jsonb; seen text[] := '{}';
begin
 if p_selection is null then return result; end if;
 if jsonb_typeof(p_selection) <> 'array' or jsonb_array_length(p_selection)>9 then raise exception 'invalid calculator selection' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(p_selection) loop
  if jsonb_typeof(a)<>'object' or coalesce(a->>'region','')='' or a->>'region'=any(seen) then raise exception 'invalid calculator area' using errcode='22023'; end if;
  select value into matched from jsonb_array_elements(p_areas) where value->>'region'=a->>'region';
  if matched is null or (a->'placements') is distinct from (matched->'placements') then raise exception 'calculator placement does not match project' using errcode='22023'; end if;
  seen:=array_append(seen,a->>'region');
  out_area:=jsonb_build_object('region',a->>'region','placements',a->'placements');
  foreach k in array array['side','half','scale','coverage','surface'] loop
   v:=a->>k;
   if v is null then continue; end if;
   if not (case k when 'side' then v=any(array['left','right','both','unsure']) when 'half' then v=any(array['upper','lower','outer','inner','unsure']) when 'scale' then v=any(array['small','area','unsure']) when 'coverage' then v=any(array['panel','wrap','unsure']) when 'surface' then v=any(array['front','back','inner','outer','unsure']) else false end) then raise exception 'invalid calculator coverage' using errcode='22023'; end if;
   out_area:=out_area||jsonb_build_object(k,v);
  end loop;
  if out_area - 'region' - 'placements' <> '{}'::jsonb then result:=result||jsonb_build_array(out_area); end if;
 end loop;
 return result;
end; $$;
revoke all on function crm_private.clean_enquiry_calculator_selection(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function crm_private.preserve_enquiry_calculator_metadata(p_old jsonb,p_new jsonb,p_input jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog,crm_private as $$
declare old_selection jsonb; new_selection jsonb; changed boolean; original jsonb:=p_old->'calculator_estimate'; out_details jsonb:=p_new;
begin
 changed:=(p_old - 'calculator_estimate' - 'calculator_selection' - 'calculator_estimate_superseded') is distinct from p_new;
 -- Original client selections have extra fields; strip them to the operator coverage shape.
 if p_old ? 'calculator_selection' then old_selection:=p_old->'calculator_selection';
 elsif original is not null and not coalesce((p_old->>'calculator_estimate_superseded')::boolean,false) then
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('region',a->'region','placements',a->'placements','side',a->'side','half',a->'half','scale',a->'scale','coverage',a->'coverage','surface',a->'surface'))),'[]'::jsonb) into old_selection from jsonb_array_elements(original->'project'->'areas') a;
 end if;
 if p_input ? 'calculator_selection' then
  new_selection:=crm_private.clean_enquiry_calculator_selection(p_input->'calculator_selection',p_input->'areas');
  changed:=changed or new_selection is distinct from coalesce(old_selection,'[]'::jsonb);
  out_details:=out_details||jsonb_build_object('calculator_selection',new_selection);
 elsif not changed and p_old ? 'calculator_selection' then
  out_details:=out_details||jsonb_build_object('calculator_selection',old_selection);
 elsif changed and old_selection is not null then
  -- Old clients cannot supply updated coverage; never display a stale selection as current.
  out_details:=out_details||jsonb_build_object('calculator_selection','[]'::jsonb);
 end if;
 if original is not null then
  out_details:=out_details||jsonb_build_object('calculator_estimate',original);
  if changed or coalesce((p_old->>'calculator_estimate_superseded')::boolean,false) then out_details:=out_details||jsonb_build_object('calculator_estimate_superseded',true); end if;
 end if;
 return out_details;
end; $$;
revoke all on function crm_private.preserve_enquiry_calculator_metadata(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.update_enquiry_project_details(p_enquiry_id uuid, p_project jsonb, p_expected jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_enquiry public.enquiries%rowtype;
  v_normalised jsonb;
  v_timing text;
  v_changed text[] := '{}'::text[];
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if p_enquiry_id is null then
    raise exception 'enquiry id is required' using errcode = '22023';
  end if;
  if p_project is null or jsonb_typeof(p_project) <> 'object' then
    raise exception 'project payload must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_project) k(key)
    where key not in ('areas', 'styles', 'sizeNotes', 'existingDetails', 'preferred_timing', 'calculator_selection')
  ) then
    raise exception 'project payload contains an unsupported field' using errcode = '22023';
  end if;
  if p_expected is null or jsonb_typeof(p_expected) <> 'object'
     or not (p_expected ? 'project_details') then
    raise exception 'the loaded project details are required to detect concurrent edits'
      using errcode = '22023';
  end if;

  select * into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id
    and e.archived_at is null
  for update;

  if not found then
    raise exception 'enquiry not found' using errcode = 'P0002';
  end if;

  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if v_enquiry.project_details is null then
    raise exception 'this enquiry has no structured project details; use the standard edit form'
      using errcode = '22023', hint = 'ENQUIRY_NOT_STRUCTURED';
  end if;

  if v_enquiry.project_details is distinct from (p_expected -> 'project_details')
     or (p_expected ? 'preferred_timing'
         and v_enquiry.preferred_timing is distinct from nullif(p_expected ->> 'preferred_timing', '')) then
    raise exception 'the enquiry was changed by someone else; reload it and try again'
      using errcode = '55000', hint = 'ENQUIRY_EDIT_CONFLICT';
  end if;

  v_normalised := crm_private.normalise_enquiry_project_input(p_project - 'preferred_timing' - 'calculator_selection');
  v_normalised := jsonb_set(v_normalised,'{project_details}',crm_private.preserve_enquiry_calculator_metadata(v_enquiry.project_details,v_normalised->'project_details',p_project));
  v_timing := case when p_project ? 'preferred_timing'
    then left(nullif(btrim(coalesce(p_project ->> 'preferred_timing', '')), ''), 160)
    else v_enquiry.preferred_timing end;

  if (v_normalised -> 'project_details') is distinct from v_enquiry.project_details then v_changed := array_append(v_changed, 'project_details'); end if;
  if (v_normalised ->> 'project_type') is distinct from v_enquiry.project_type then v_changed := array_append(v_changed, 'project_type'); end if;
  if (v_normalised ->> 'placement') is distinct from v_enquiry.placement then v_changed := array_append(v_changed, 'placement'); end if;
  if (v_normalised ->> 'approximate_size') is distinct from v_enquiry.approximate_size then v_changed := array_append(v_changed, 'approximate_size'); end if;
  if (v_normalised ->> 'cover_up') is distinct from v_enquiry.cover_up then v_changed := array_append(v_changed, 'cover_up'); end if;
  if v_timing is distinct from v_enquiry.preferred_timing then v_changed := array_append(v_changed, 'preferred_timing'); end if;

  if cardinality(v_changed) > 0 then
    update public.enquiries e
    set project_details = v_normalised -> 'project_details',
        project_type = v_normalised ->> 'project_type',
        placement = v_normalised ->> 'placement',
        approximate_size = v_normalised ->> 'approximate_size',
        cover_up = v_normalised ->> 'cover_up',
        preferred_timing = v_timing,
        updated_at = now(),
        last_action_at = now()
    where e.id = p_enquiry_id;

    v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
    perform crm_private.log_artist_activity(
      v_enquiry.artist_id,
      'enquiry.updated',
      v_actor_kind,
      auth.uid(),
      v_enquiry.client_id,
      p_enquiry_id,
      null,
      null,
      null,
      jsonb_build_object('changed_fields', to_jsonb(v_changed), 'structured', true)
    );
  end if;

  return jsonb_build_object(
    'enquiry_id', p_enquiry_id,
    'changed_fields', to_jsonb(v_changed),
    'project_details', v_normalised -> 'project_details',
    'project_type', v_normalised ->> 'project_type',
    'placement', v_normalised ->> 'placement',
    'approximate_size', v_normalised ->> 'approximate_size',
    'cover_up', v_normalised ->> 'cover_up',
    'preferred_timing', v_timing
  );
end;
$function$
;
