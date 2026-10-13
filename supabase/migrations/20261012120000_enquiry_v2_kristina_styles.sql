-- Kristina Vishar's booking form moves to enquiry-v2.
--
-- Adds Kristina's colour styles (artist = "kristina") to the v2 catalogue and
-- derives project_type from their labels instead of realism wording, for
-- example "Floral / botanical + Watercolour". Realism styles derive exactly as
-- before, so existing enquiries and Vladimir's form are unchanged.
--
-- Both functions must stay equal to config/enquiry-form-v2.json and to
-- deriveLegacyFields in workers/lib/enquiry-v2.js; enforced by
-- scripts/test-enquiry-v2-sql-catalogue.mjs and supabase/tests/331.

create or replace function crm_private.enquiry_v2_catalogue()
returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select '{"schema":"enquiry-v2","regions":[{"key":"arm","label":"Arm","placements":[{"key":"shoulder","label":"Shoulder"},{"key":"upper_arm","label":"Upper arm"},{"key":"inner_bicep","label":"Inner bicep"},{"key":"elbow","label":"Elbow"},{"key":"forearm","label":"Forearm"},{"key":"wrist","label":"Wrist"},{"key":"half_sleeve","label":"Half sleeve","large":true,"group":"arm_sleeve"},{"key":"three_quarter_sleeve","label":"3/4 sleeve","large":true,"group":"arm_sleeve"},{"key":"full_sleeve","label":"Full sleeve","large":true,"group":"arm_sleeve"},{"key":"other","label":"Other"}]},{"key":"leg","label":"Leg","placements":[{"key":"thigh","label":"Thigh"},{"key":"knee","label":"Knee"},{"key":"calf","label":"Calf"},{"key":"shin","label":"Shin"},{"key":"ankle","label":"Ankle"},{"key":"half_leg_sleeve","label":"Half leg sleeve","large":true,"group":"leg_sleeve"},{"key":"full_leg_sleeve","label":"Full leg sleeve","large":true,"group":"leg_sleeve"},{"key":"other","label":"Other"}]},{"key":"chest_ribs","label":"Chest & Ribs","placements":[{"key":"sternum","label":"Sternum"},{"key":"one_side_chest","label":"One side of chest"},{"key":"collarbone","label":"Collarbone"},{"key":"ribs","label":"Ribs"},{"key":"full_chest","label":"Full chest","large":true},{"key":"other","label":"Other"}]},{"key":"back","label":"Back","placements":[{"key":"upper_back","label":"Upper back"},{"key":"shoulder_blade","label":"Shoulder blade"},{"key":"spine","label":"Spine"},{"key":"lower_back","label":"Lower back"},{"key":"full_back","label":"Full back","large":true},{"key":"other","label":"Other"}]},{"key":"stomach_sides","label":"Stomach & Sides","placements":[{"key":"stomach","label":"Stomach"},{"key":"side","label":"Side"},{"key":"hip","label":"Hip"},{"key":"other","label":"Other"}]},{"key":"neck_head","label":"Neck & Head","placements":[{"key":"front_neck","label":"Front of neck"},{"key":"side_neck","label":"Side of neck"},{"key":"back_neck","label":"Back of neck"},{"key":"behind_ear","label":"Behind the ear"},{"key":"head","label":"Head"},{"key":"other","label":"Other"}]},{"key":"hand","label":"Hand","placements":[{"key":"back_of_hand","label":"Back of hand"},{"key":"fingers","label":"Fingers"},{"key":"side_of_hand","label":"Side of hand"},{"key":"other","label":"Other"}]},{"key":"foot","label":"Foot","placements":[{"key":"top_of_foot","label":"Top of foot"},{"key":"side_of_foot","label":"Side of foot"},{"key":"toes","label":"Toes"},{"key":"other","label":"Other"}]},{"key":"other","label":"Other","placements":[]}],"work":[{"key":"new","label":"New tattoo","exclusive":true},{"key":"extension","label":"Extension"},{"key":"cover_up","label":"Cover-up"},{"key":"rework","label":"Rework"}],"styles":[{"key":"black_grey","label":"Black & Grey realism"},{"key":"colour","label":"Colour realism"},{"key":"floral","label":"Floral / botanical","artist":"kristina"},{"key":"watercolour","label":"Watercolour","artist":"kristina"},{"key":"custom_colour","label":"Custom colour","artist":"kristina"},{"key":"miniature","label":"Miniature / small tattoo","artist":"kristina"},{"key":"anime","label":"Anime / cartoon","artist":"kristina"},{"key":"micro_realism","label":"Micro-realism","artist":"kristina"},{"key":"not_sure","label":"Not sure yet","exclusive":true}],"limits":{"maxAreas":9,"otherText":120,"sizeNotes":160,"existingDetails":1000,"maxFilesPerRole":4,"maxFilesTotal":6}}'::jsonb;
$$;

revoke all on function crm_private.enquiry_v2_catalogue()
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_v2_catalogue() is
  'Booking form v2 catalogue (regions, placements, work, styles, limits). Must equal config/enquiry-form-v2.json without "note"; enforced by scripts/test-enquiry-v2-sql-catalogue.mjs.';

-- Same cleaning as text() in workers/lib/enquiry-v2.js.

create or replace function crm_private.normalise_enquiry_project_input(p_input jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_cat jsonb := crm_private.enquiry_v2_catalogue();
  v_limits jsonb := v_cat -> 'limits';
  v_area jsonb;
  v_region jsonb;
  v_region_key text;
  v_seen_regions text[] := '{}';
  v_placement_keys text[];
  v_work_keys text[];
  v_style_keys text[];
  v_key text;
  v_placement jsonb;
  v_placement_labels text[];
  v_groups text[];
  v_large boolean;
  v_needs_other boolean;
  v_other text;
  v_areas_out jsonb := '[]'::jsonb;
  v_summaries text[] := '{}';
  v_where text[];
  v_all_work text[] := '{}';
  v_any_large boolean := false;
  v_has_existing boolean := false;
  v_requires_design boolean := false;
  v_size_notes text;
  v_existing_details text;
  v_details jsonb;
  v_project_type text;
  v_cover_up text;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'project details must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) k(key)
    where key not in ('areas', 'styles', 'sizeNotes', 'existingDetails')
  ) then
    raise exception 'project details contain an unsupported field' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'areas') is distinct from 'array'
     or jsonb_array_length(p_input -> 'areas') < 1
     or jsonb_array_length(p_input -> 'areas') > (v_limits ->> 'maxAreas')::integer then
    raise exception 'choose at least one body area' using errcode = '22023', hint = 'MISSING_BODY_AREA';
  end if;

  for v_area in select value from jsonb_array_elements(p_input -> 'areas') with ordinality o(value, n) order by n loop
    if jsonb_typeof(v_area) <> 'object' then
      raise exception 'invalid body area' using errcode = '22023';
    end if;
    v_region_key := v_area ->> 'region';
    select r into v_region from jsonb_array_elements(v_cat -> 'regions') as _r(r) where r ->> 'key' = v_region_key;
    if v_region is null or v_region_key = any(v_seen_regions) then
      raise exception 'unknown or repeated body area' using errcode = '22023';
    end if;
    v_seen_regions := array_append(v_seen_regions, v_region_key);

    -- placements
    if coalesce(jsonb_typeof(v_area -> 'placements'), 'array') <> 'array' then
      raise exception 'invalid placements' using errcode = '22023';
    end if;
    select coalesce(array_agg(p #>> '{}' order by n), '{}') into v_placement_keys
    from jsonb_array_elements(coalesce(v_area -> 'placements', '[]'::jsonb)) with ordinality x(p, n);
    if exists (select 1 from jsonb_array_elements(coalesce(v_area -> 'placements', '[]'::jsonb)) as _p(p) where jsonb_typeof(p) <> 'string' or p #>> '{}' = '')
       or cardinality(v_placement_keys) <> (select count(distinct k) from unnest(v_placement_keys) k) then
      raise exception 'invalid placements' using errcode = '22023';
    end if;

    v_placement_labels := '{}';
    v_groups := '{}';
    v_large := false;
    foreach v_key in array v_placement_keys loop
      select p into v_placement from jsonb_array_elements(v_region -> 'placements') as _p(p) where p ->> 'key' = v_key;
      if v_placement is null then
        raise exception 'unknown placement' using errcode = '22023';
      end if;
      v_placement_labels := array_append(v_placement_labels, v_placement ->> 'label');
      if v_placement ? 'group' then v_groups := array_append(v_groups, v_placement ->> 'group'); end if;
      if coalesce((v_placement ->> 'large')::boolean, false) then v_large := true; end if;
      v_placement := null;
    end loop;
    if cardinality(v_groups) <> (select count(distinct g) from unnest(v_groups) g) then
      raise exception 'choose one sleeve length per area' using errcode = '22023';
    end if;

    v_needs_other := v_region_key = 'other' or 'other' = any(v_placement_keys);
    v_other := case when v_needs_other
      then crm_private.enquiry_v2_text(v_area -> 'otherPlacement', (v_limits ->> 'otherText')::integer)
      else '' end;
    if v_region_key <> 'other' and cardinality(v_placement_keys) = 0 then
      raise exception 'choose a placement for %', v_region ->> 'label' using errcode = '22023', hint = 'MISSING_PLACEMENT';
    end if;
    if v_needs_other and v_other = '' then
      raise exception 'describe the placement' using errcode = '22023', hint = 'MISSING_PLACEMENT';
    end if;

    -- work
    if coalesce(jsonb_typeof(v_area -> 'work'), 'array') <> 'array'
       or exists (select 1 from jsonb_array_elements(coalesce(v_area -> 'work', '[]'::jsonb)) as _w(w) where jsonb_typeof(w) <> 'string' or w #>> '{}' = '') then
      raise exception 'invalid work type' using errcode = '22023';
    end if;
    select coalesce(array_agg(w #>> '{}' order by n), '{}') into v_work_keys
    from jsonb_array_elements(coalesce(v_area -> 'work', '[]'::jsonb)) with ordinality x(w, n);
    if cardinality(v_work_keys) = 0 then
      raise exception 'say whether % has existing tattoo work', v_region ->> 'label' using errcode = '22023', hint = 'MISSING_EXISTING_WORK';
    end if;
    if cardinality(v_work_keys) <> (select count(distinct k) from unnest(v_work_keys) k)
       or exists (select 1 from unnest(v_work_keys) k
                  where not exists (select 1 from jsonb_array_elements(v_cat -> 'work') as _w(w) where w ->> 'key' = k)) then
      raise exception 'invalid work type' using errcode = '22023';
    end if;
    if 'new' = any(v_work_keys) and cardinality(v_work_keys) > 1 then
      raise exception 'No existing tattoo cannot be combined with other options for the same area' using errcode = '22023';
    end if;

    v_all_work := v_all_work || v_work_keys;
    v_any_large := v_any_large or v_large;
    if v_work_keys && array['extension', 'cover_up', 'rework'] then v_has_existing := true; end if;
    if 'new' = any(v_work_keys) or 'extension' = any(v_work_keys)
       or (v_large and v_work_keys && array['cover_up', 'rework']) then
      v_requires_design := true;
    end if;

    v_areas_out := v_areas_out || jsonb_build_array(
      jsonb_build_object(
        'region', v_region ->> 'label',
        'placements', to_jsonb(v_placement_labels)
      )
      || case when v_other <> '' then jsonb_build_object('otherPlacement', v_other) else '{}'::jsonb end
      || jsonb_build_object('work', (
        select jsonb_agg(w ->> 'label' order by n)
        from unnest(v_work_keys) with ordinality u(k, n)
        join jsonb_array_elements(v_cat -> 'work') as _w(w) on w ->> 'key' = u.k
      ))
    );

    v_where := array_remove(v_placement_labels, 'Other');
    if v_other <> '' then v_where := array_append(v_where, v_other); end if;
    v_summaries := array_append(v_summaries, case when cardinality(v_where) > 0
      then (v_region ->> 'label') || ': ' || array_to_string(v_where, ', ')
      else v_region ->> 'label' end);
    v_region := null;
  end loop;

  -- styles
  if coalesce(jsonb_typeof(p_input -> 'styles'), 'array') <> 'array'
     or exists (select 1 from jsonb_array_elements(coalesce(p_input -> 'styles', '[]'::jsonb)) as _s(s) where jsonb_typeof(s) <> 'string' or s #>> '{}' = '') then
    raise exception 'invalid style' using errcode = '22023';
  end if;
  select coalesce(array_agg(s #>> '{}' order by n), '{}') into v_style_keys
  from jsonb_array_elements(coalesce(p_input -> 'styles', '[]'::jsonb)) with ordinality x(s, n);
  if cardinality(v_style_keys) = 0 then
    raise exception 'choose a style or Not sure yet' using errcode = '22023', hint = 'MISSING_STYLE';
  end if;
  if cardinality(v_style_keys) <> (select count(distinct k) from unnest(v_style_keys) k)
     or exists (select 1 from unnest(v_style_keys) k
                where not exists (select 1 from jsonb_array_elements(v_cat -> 'styles') as _s(s) where s ->> 'key' = k))
     or ('not_sure' = any(v_style_keys) and cardinality(v_style_keys) > 1) then
    raise exception 'invalid style' using errcode = '22023';
  end if;

  v_size_notes := crm_private.enquiry_v2_text(p_input -> 'sizeNotes', (v_limits ->> 'sizeNotes')::integer);
  v_existing_details := case when v_has_existing
    then crm_private.enquiry_v2_text(p_input -> 'existingDetails', (v_limits ->> 'existingDetails')::integer)
    else '' end;

  v_details := jsonb_build_object(
    'schema', v_cat ->> 'schema',
    'areas', v_areas_out,
    'styles', (
      select jsonb_agg(s ->> 'label' order by n)
      from unnest(v_style_keys) with ordinality u(k, n)
      join jsonb_array_elements(v_cat -> 'styles') as _s(s) on s ->> 'key' = u.k
    )
  )
  || case when v_size_notes <> '' then jsonb_build_object('sizeNotes', v_size_notes) else '{}'::jsonb end
  || case when v_existing_details <> '' then jsonb_build_object('existingDetails', v_existing_details) else '{}'::jsonb end
  || jsonb_build_object('imageRequirements', jsonb_build_object(
       'designReference', v_requires_design,
       'existingTattooPhoto', v_has_existing));

  -- deriveLegacyFields
  v_project_type := case
    when 'cover_up' = any(v_all_work) then 'Cover-up'
    when v_any_large then 'Large-scale project / sleeve'
    when 'not_sure' = any(v_style_keys) then 'Not sure yet'
    when exists (select 1 from unnest(v_style_keys) k where k not in ('black_grey', 'colour')) then left((
      select string_agg(s ->> 'label', ' + ' order by n)
      from unnest(v_style_keys) with ordinality u(k, n)
      join jsonb_array_elements(v_cat -> 'styles') as _s(s) on s ->> 'key' = u.k
    ), 100)
    when cardinality(v_style_keys) = 2 then 'Colour and black and grey realism'
    when v_style_keys[1] = 'colour' then 'Colour realism'
    else 'Black and grey realism' end;
  v_cover_up := case
    when 'cover_up' = any(v_all_work) then 'Yes'
    when v_all_work && array['rework', 'extension'] then 'Existing tattoo'
    else 'No' end;

  return jsonb_build_object(
    'project_details', v_details,
    'project_type', v_project_type,
    'placement', left(array_to_string(v_summaries, '; '), 160),
    'approximate_size', left(coalesce(nullif(v_size_notes, ''), 'Not specified'), 120),
    'cover_up', v_cover_up
  );
end;
$$;

revoke all on function crm_private.normalise_enquiry_project_input(jsonb)
  from public, anon, authenticated, service_role;

comment on function crm_private.normalise_enquiry_project_input(jsonb) is
  'SQL port of parseProjectDetails + deriveLegacyFields (workers/lib/enquiry-v2.js). Key-based input, label-based project_details output plus the four derived legacy column values.';
