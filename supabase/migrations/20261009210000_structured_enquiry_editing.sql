-- 20261009210000_structured_enquiry_editing.sql
--
-- Operator editing of booking form v2 answers (enquiries.project_details).
--
-- Until now Edit enquiry rewrote only the legacy text columns. On a v2
-- enquiry that let the card (project_details) and the derived columns
-- (project_type, placement, approximate_size, cover_up) disagree.
--
--   * crm_private.enquiry_v2_catalogue()   the form catalogue
--     (config/enquiry-form-v2.json without "note"); a repository test keeps
--     the literal equal to the file.
--   * crm_private.normalise_enquiry_project_input(jsonb)
--     SQL port of workers/lib/enquiry-v2.js parseProjectDetails +
--     deriveLegacyFields. Input uses catalogue keys, exactly like the form;
--     output is the stored label shape plus the four legacy column values.
--   * public.update_enquiry_project_details(uuid, jsonb, jsonb)
--     structured edit with an optimistic content check: the caller sends
--     the project_details and preferred_timing it loaded; a change made in
--     between is refused (55000, hint ENQUIRY_EDIT_CONFLICT). The client's
--     own text (idea) is never touched here.
--   * crm_private.update_enquiry_details_core
--     rebuilt from the production definition. On a structured enquiry the
--     four derived columns can no longer be set by hand (CRM or GPT), which
--     is what produced contradictions. Unchanged values, timing and idea are
--     still accepted; legacy enquiries behave exactly as before.
--
-- Triggers are unchanged. The client-AI refresh trigger already fires on
-- these columns and is still gated by crm_agent_config.enabled.

-- ---------------------------------------------------------------------------
-- 1. Catalogue
-- ---------------------------------------------------------------------------

create or replace function crm_private.enquiry_v2_catalogue()
returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select '{"schema":"enquiry-v2","regions":[{"key":"arm","label":"Arm","placements":[{"key":"shoulder","label":"Shoulder"},{"key":"upper_arm","label":"Upper arm"},{"key":"inner_bicep","label":"Inner bicep"},{"key":"elbow","label":"Elbow"},{"key":"forearm","label":"Forearm"},{"key":"wrist","label":"Wrist"},{"key":"half_sleeve","label":"Half sleeve","large":true,"group":"arm_sleeve"},{"key":"three_quarter_sleeve","label":"3/4 sleeve","large":true,"group":"arm_sleeve"},{"key":"full_sleeve","label":"Full sleeve","large":true,"group":"arm_sleeve"},{"key":"other","label":"Other"}]},{"key":"leg","label":"Leg","placements":[{"key":"thigh","label":"Thigh"},{"key":"knee","label":"Knee"},{"key":"calf","label":"Calf"},{"key":"shin","label":"Shin"},{"key":"ankle","label":"Ankle"},{"key":"half_leg_sleeve","label":"Half leg sleeve","large":true,"group":"leg_sleeve"},{"key":"full_leg_sleeve","label":"Full leg sleeve","large":true,"group":"leg_sleeve"},{"key":"other","label":"Other"}]},{"key":"chest_ribs","label":"Chest & Ribs","placements":[{"key":"sternum","label":"Sternum"},{"key":"one_side_chest","label":"One side of chest"},{"key":"collarbone","label":"Collarbone"},{"key":"ribs","label":"Ribs"},{"key":"full_chest","label":"Full chest","large":true},{"key":"other","label":"Other"}]},{"key":"back","label":"Back","placements":[{"key":"upper_back","label":"Upper back"},{"key":"shoulder_blade","label":"Shoulder blade"},{"key":"spine","label":"Spine"},{"key":"lower_back","label":"Lower back"},{"key":"full_back","label":"Full back","large":true},{"key":"other","label":"Other"}]},{"key":"stomach_sides","label":"Stomach & Sides","placements":[{"key":"stomach","label":"Stomach"},{"key":"side","label":"Side"},{"key":"hip","label":"Hip"},{"key":"other","label":"Other"}]},{"key":"neck_head","label":"Neck & Head","placements":[{"key":"front_neck","label":"Front of neck"},{"key":"side_neck","label":"Side of neck"},{"key":"back_neck","label":"Back of neck"},{"key":"behind_ear","label":"Behind the ear"},{"key":"head","label":"Head"},{"key":"other","label":"Other"}]},{"key":"hand","label":"Hand","placements":[{"key":"back_of_hand","label":"Back of hand"},{"key":"fingers","label":"Fingers"},{"key":"side_of_hand","label":"Side of hand"},{"key":"other","label":"Other"}]},{"key":"foot","label":"Foot","placements":[{"key":"top_of_foot","label":"Top of foot"},{"key":"side_of_foot","label":"Side of foot"},{"key":"toes","label":"Toes"},{"key":"other","label":"Other"}]},{"key":"other","label":"Other","placements":[]}],"work":[{"key":"new","label":"New tattoo","exclusive":true},{"key":"extension","label":"Extension"},{"key":"cover_up","label":"Cover-up"},{"key":"rework","label":"Rework"}],"styles":[{"key":"black_grey","label":"Black & Grey realism"},{"key":"colour","label":"Colour realism"},{"key":"not_sure","label":"Not sure yet","exclusive":true}],"limits":{"maxAreas":9,"otherText":120,"sizeNotes":160,"existingDetails":1000,"maxFilesPerRole":4,"maxFilesTotal":6}}'::jsonb;
$$;

revoke all on function crm_private.enquiry_v2_catalogue()
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_v2_catalogue() is
  'Booking form v2 catalogue (regions, placements, work, styles, limits). Must equal config/enquiry-form-v2.json without "note"; enforced by scripts/test-enquiry-v2-sql-catalogue.mjs.';

-- Same cleaning as text() in workers/lib/enquiry-v2.js.
create or replace function crm_private.enquiry_v2_text(p_value jsonb, p_max integer)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case when jsonb_typeof(p_value) = 'string'
    then left(regexp_replace(regexp_replace(p_value #>> '{}', '^\s+|\s+$', '', 'g'), E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', 'g'), p_max)
    else '' end;
$$;

revoke all on function crm_private.enquiry_v2_text(jsonb, integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Normaliser
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 3. Structured edit RPC
-- ---------------------------------------------------------------------------

create or replace function public.update_enquiry_project_details(
  p_enquiry_id uuid,
  p_project jsonb,
  p_expected jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
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
    where key not in ('areas', 'styles', 'sizeNotes', 'existingDetails', 'preferred_timing')
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

  v_normalised := crm_private.normalise_enquiry_project_input(p_project - 'preferred_timing');
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
$$;

revoke all on function public.update_enquiry_project_details(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_enquiry_project_details(uuid, jsonb, jsonb)
  to authenticated;

comment on function public.update_enquiry_project_details(uuid, jsonb, jsonb) is
  'Artist-scoped structured edit of a booking form v2 enquiry. Re-normalises project_details from catalogue keys, recomputes project_type/placement/approximate_size/cover_up on the server, refuses concurrent edits (hint ENQUIRY_EDIT_CONFLICT) and never changes the client''s idea text.';

-- ---------------------------------------------------------------------------
-- 4. Legacy edit core: derived columns are read-only on structured enquiries
-- ---------------------------------------------------------------------------

create or replace function crm_private.update_enquiry_details_core(p_enquiry_id uuid, p_enquiry jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_project_type text;
  v_placement text;
  v_approximate_size text;
  v_cover_up text;
  v_preferred_timing text;
  v_idea text;
  v_changed text[] := '{}'::text[];
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if p_enquiry_id is null then
    raise exception 'enquiry id is required' using errcode = '22023';
  end if;
  if p_enquiry is null or jsonb_typeof(p_enquiry) <> 'object' then
    raise exception 'enquiry payload must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_enquiry) as k(key)
    where key not in (
      'project_type', 'placement', 'approximate_size',
      'cover_up', 'preferred_timing', 'idea'
    )
  ) then
    raise exception 'enquiry payload contains an unsupported field' using errcode = '22023';
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

  v_project_type := case when p_enquiry ? 'project_type'
    then left(nullif(btrim(coalesce(p_enquiry ->> 'project_type', '')), ''), 100)
    else v_enquiry.project_type end;
  v_placement := case when p_enquiry ? 'placement'
    then left(nullif(btrim(coalesce(p_enquiry ->> 'placement', '')), ''), 160)
    else v_enquiry.placement end;
  v_approximate_size := case when p_enquiry ? 'approximate_size'
    then left(nullif(btrim(coalesce(p_enquiry ->> 'approximate_size', '')), ''), 120)
    else v_enquiry.approximate_size end;
  v_cover_up := case when p_enquiry ? 'cover_up'
    then left(nullif(btrim(coalesce(p_enquiry ->> 'cover_up', '')), ''), 40)
    else v_enquiry.cover_up end;
  v_preferred_timing := case when p_enquiry ? 'preferred_timing'
    then left(nullif(btrim(coalesce(p_enquiry ->> 'preferred_timing', '')), ''), 160)
    else v_enquiry.preferred_timing end;
  v_idea := case when p_enquiry ? 'idea'
    then left(nullif(btrim(coalesce(p_enquiry ->> 'idea', '')), ''), 4000)
    else v_enquiry.idea end;

  if v_project_type is distinct from v_enquiry.project_type then v_changed := array_append(v_changed, 'project_type'); end if;
  if v_placement is distinct from v_enquiry.placement then v_changed := array_append(v_changed, 'placement'); end if;
  if v_approximate_size is distinct from v_enquiry.approximate_size then v_changed := array_append(v_changed, 'approximate_size'); end if;
  if v_cover_up is distinct from v_enquiry.cover_up then v_changed := array_append(v_changed, 'cover_up'); end if;
  if v_preferred_timing is distinct from v_enquiry.preferred_timing then v_changed := array_append(v_changed, 'preferred_timing'); end if;
  if v_idea is distinct from v_enquiry.idea then v_changed := array_append(v_changed, 'idea'); end if;

  -- On a booking form v2 enquiry these four columns are derived from
  -- project_details. Setting them by hand would contradict the structured
  -- answers, so they change only through update_enquiry_project_details.
  if v_enquiry.project_details is not null
     and v_changed && array['project_type', 'placement', 'approximate_size', 'cover_up'] then
    raise exception 'type, placement, size and cover-up of this enquiry come from its body areas; edit the body areas instead'
      using errcode = '22023', hint = 'ENQUIRY_STRUCTURED_FIELDS';
  end if;

  if cardinality(v_changed) > 0 then
    update public.enquiries e
    set project_type = v_project_type,
        placement = v_placement,
        approximate_size = v_approximate_size,
        cover_up = v_cover_up,
        preferred_timing = v_preferred_timing,
        idea = v_idea,
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
      jsonb_build_object('changed_fields', to_jsonb(v_changed))
    );
  end if;

  return jsonb_build_object(
    'enquiry_id', p_enquiry_id,
    'changed_fields', to_jsonb(v_changed)
  );
end;
$$;
