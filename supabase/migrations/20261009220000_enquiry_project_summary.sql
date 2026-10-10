-- 20261009220000_enquiry_project_summary.sql
--
-- One compact, trustworthy description of a booking form v2 project for every
-- list in the CRM and for the GPT/MCP enquiry reads.
--
-- A request for a full sleeve with a forearm cover-up and a separate leg
-- tattoo was shown in lists only as project_type = 'Cover-up'. Lists now read
-- enquiries.project_summary, e.g. "Full sleeve + Forearm cover-up + Leg tattoo".
--
--   * crm_private.enquiry_project_summary(jsonb)  immutable; follows the
--     Worker rule that a cover-up or rework inside a sleeve or panel belongs
--     to a larger new design: large placements are named on their own,
--     smaller placements carry the existing-work label, a new-only area is
--     "<Region> tattoo". NULL for legacy enquiries.
--   * enquiries.project_summary  STORED generated column. It is computed
--     when project_details is written (intake, structured edit), so Today,
--     the board and client pages read one short text column with no extra
--     query and no per-row function call.
--   * GPT/MCP reads (additive, columns appended, nothing removed):
--       gpt_list_enquiries   + project_summary
--       gpt_get_enquiry      + project_summary, project_details
--       gpt_get_enquiry_full + project_summary, project_details
--       gpt_list_enquiry_files + intake_role
--       reference_analyses images + role (design_reference / existing_tattoo)
--     The client's own text (idea) and every legacy column stay as they are.

create or replace function crm_private.enquiry_project_summary(p_details jsonb)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, crm_private
as $$
declare
  v_regions jsonb := crm_private.enquiry_v2_catalogue() -> 'regions';
  v_area jsonb;
  v_region jsonb;
  v_region_label text;
  v_label text;
  v_other text;
  v_large text[];
  v_small text[];
  v_existing text;
  v_parts text[] := '{}';
begin
  if p_details is null or jsonb_typeof(p_details -> 'areas') is distinct from 'array' then
    return null;
  end if;

  for v_area in select value from jsonb_array_elements(p_details -> 'areas') with ordinality o(value, n) order by n loop
    continue when jsonb_typeof(v_area) <> 'object';
    v_region_label := coalesce(v_area ->> 'region', 'Other');
    select r into v_region from jsonb_array_elements(v_regions) as _r(r) where r ->> 'label' = v_region_label;
    v_other := nullif(btrim(coalesce(v_area ->> 'otherPlacement', '')), '');
    v_large := '{}';
    v_small := '{}';

    if v_region ->> 'key' = 'other' then
      v_region_label := coalesce(v_other, v_region_label);
    else
      for v_label in
        select p #>> '{}' from jsonb_array_elements(
          case when jsonb_typeof(v_area -> 'placements') = 'array' then v_area -> 'placements' else '[]'::jsonb end
        ) with ordinality x(p, n) order by n
      loop
        continue when v_label = 'Other';
        if exists (
          select 1 from jsonb_array_elements(coalesce(v_region -> 'placements', '[]'::jsonb)) as _p(p)
          where p ->> 'label' = v_label and coalesce((p ->> 'large')::boolean, false)
        ) then
          v_large := array_append(v_large, v_label);
        else
          v_small := array_append(v_small, v_label);
        end if;
      end loop;
      if v_other is not null then v_small := array_append(v_small, v_other); end if;
    end if;

    select string_agg(lower(w #>> '{}'), '/' order by n) into v_existing
    from jsonb_array_elements(
      case when jsonb_typeof(v_area -> 'work') = 'array' then v_area -> 'work' else '[]'::jsonb end
    ) with ordinality x(w, n)
    where w #>> '{}' <> 'New tattoo';

    if v_existing is null then
      v_parts := v_parts || v_large;
      if cardinality(v_small) > 0 or cardinality(v_large) = 0 then
        v_parts := array_append(v_parts, v_region_label || ' tattoo');
      end if;
    elsif cardinality(v_small) > 0 then
      v_parts := v_parts || v_large
        || array(select s || ' ' || v_existing from unnest(v_small) with ordinality u(s, n) order by n);
    elsif cardinality(v_large) > 0 then
      v_parts := v_parts
        || array(select l || ' ' || v_existing from unnest(v_large) with ordinality u(l, n) order by n);
    else
      v_parts := array_append(v_parts, v_region_label || ' ' || v_existing);
    end if;
    v_region := null;
  end loop;

  if cardinality(v_parts) = 0 then
    return null;
  end if;
  return left(array_to_string(v_parts, ' + '), 200);
end;
$$;

revoke all on function crm_private.enquiry_project_summary(jsonb)
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_project_summary(jsonb) is
  'Compact project description from booking form v2 project_details, e.g. "Full sleeve + Forearm cover-up + Leg tattoo". NULL for legacy enquiries.';

alter table public.enquiries
  add column if not exists project_summary text
  generated always as (crm_private.enquiry_project_summary(project_details)) stored;

comment on column public.enquiries.project_summary is
  'Generated from project_details for lists and GPT reads. NULL for legacy enquiries; readers fall back to project_type.';

grant select (project_summary) on public.enquiries to authenticated;

-- ---------------------------------------------------------------------------
-- Image roles in the stored analyses (rebuilt from the production definition
-- of 20261006090000; only 'role' is added).
-- ---------------------------------------------------------------------------

create or replace function crm_private.enquiry_reference_analyses(p_enquiry_id uuid)
returns jsonb
language sql
stable security definer
set search_path = pg_catalog, public, crm_private
as $$
  with ready as (
    select f.id, f.intake_role, row_number() over (order by f.ordinal, f.id) as position,
           count(*) over () as total
    from public.enquiry_files f
    where f.enquiry_id = p_enquiry_id and f.upload_state = 'ready'
  ), photos as (
    select r.position, r.total, r.intake_role, a.analysis, a.summary, a.model, a.analyzed_at
    from ready r
    left join public.enquiry_file_ai_analysis a on a.enquiry_file_id = r.id
  )
  select jsonb_build_object(
    'note', 'Stored vision-model analysis of the client''s attached photos, not re-summarised. Photos are numbered as in the CRM. Use them with the client''s own text when reviewing the request, references, cover-up and placement. The photos and the client''s words are authoritative; anything an analysis does not show is unknown. role is what the client said the photo shows (design_reference or existing_tattoo); it is absent for older enquiries and staff uploads.',
    'images', coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'image', p.position || ' of ' || p.total,
          'role', p.intake_role,
          'summary', left(coalesce(p.analysis ->> 'summary', p.summary), 1200),
          'image_kind', p.analysis -> 'image_kind',
          'existing_tattoo_visible', p.analysis -> 'existing_tattoo_visible',
          'body_area', p.analysis -> 'body_area',
          'subjects', p.analysis -> 'subjects',
          'composition', p.analysis -> 'composition',
          'palette', p.analysis -> 'palette',
          'quality_limitations', p.analysis -> 'quality_limitations',
          'model', p.model,
          'analysed_at', p.analyzed_at))
        order by p.position)
      from (select * from photos where model is not null order by position limit 8) p
    ), '[]'::jsonb),
    'not_analysed', coalesce((
      select jsonb_agg(p.position || ' of ' || p.total order by p.position)
      from photos p where p.model is null
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- GPT / MCP enquiry reads. Return types gain columns, so each function is
-- recreated with its existing ACL and comment. Columns are appended.
-- ---------------------------------------------------------------------------

drop function if exists public.gpt_list_enquiries(timestamp with time zone, timestamp with time zone, public.enquiry_status, integer);
create function public.gpt_list_enquiries(
  p_from timestamp with time zone default null,
  p_to timestamp with time zone default null,
  p_status public.enquiry_status default null,
  p_limit integer default 20
)
returns table(enquiry_id uuid, reference_number text, status public.enquiry_status, client_id uuid, client_name text, project_type text, placement text, preferred_timing text, created_at timestamp with time zone, last_action_at timestamp with time zone, project_summary text)
language plpgsql
stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_limit integer;
begin
  if p_from is not null and p_to is not null and p_to <= p_from then
    raise exception 'enquiry range end must be after its start'
      using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_to - p_from > interval '366 days' then
    raise exception 'enquiry range may not exceed 366 days'
      using errcode = '22023';
  end if;

  select c.artist_id into v_artist_id
  from crm_private.require_gpt_enquiry_context() c;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 25);

  return query
  select
    e.id,
    e.reference_number,
    e.status,
    e.client_id,
    cl.full_name,
    e.project_type,
    e.placement,
    e.preferred_timing,
    e.created_at,
    e.last_action_at,
    e.project_summary
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  where e.artist_id = v_artist_id
    and e.intake_state = 'complete'
    and (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at < p_to)
    and (p_status is null or e.status = p_status)
  order by e.created_at desc, e.id
  limit v_limit;
end;
$$;
revoke all on function public.gpt_list_enquiries(timestamp with time zone, timestamp with time zone, public.enquiry_status, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_list_enquiries(timestamp with time zone, timestamp with time zone, public.enquiry_status, integer)
  to authenticated;
comment on function public.gpt_list_enquiries(timestamp with time zone, timestamp with time zone, public.enquiry_status, integer) is
  'Lists complete enquiries only inside the OAuth client fixed artist scope through a contact-detail-free read surface. project_summary describes booking form v2 projects (NULL for legacy; use project_type).';

drop function if exists public.gpt_get_enquiry(uuid);
create function public.gpt_get_enquiry(p_enquiry_id uuid)
returns table(enquiry_id uuid, reference_number text, status public.enquiry_status, client_id uuid, client_name text, project_type text, placement text, approximate_size text, cover_up text, preferred_timing text, idea text, created_at timestamp with time zone, last_action_at timestamp with time zone, project_summary text, project_details jsonb)
language plpgsql
stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_enquiry_context() c;

  return query
  select
    e.id,
    e.reference_number,
    e.status,
    e.client_id,
    cl.full_name,
    e.project_type,
    e.placement,
    e.approximate_size,
    e.cover_up,
    e.preferred_timing,
    e.idea,
    e.created_at,
    e.last_action_at,
    e.project_summary,
    e.project_details
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  where e.id = p_enquiry_id
    and e.artist_id = v_artist_id
    and e.intake_state = 'complete';
end;
$$;
revoke all on function public.gpt_get_enquiry(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_enquiry(uuid) to authenticated;
comment on function public.gpt_get_enquiry(uuid) is
  'Reads one complete enquiry only inside the OAuth client fixed artist scope through a contact-detail-free detail surface. project_details holds every body area, placement, kind of work and style the client chose; idea is the client''s own text.';

drop function if exists public.gpt_get_enquiry_full(uuid);
create function public.gpt_get_enquiry_full(p_enquiry_id uuid)
returns table(enquiry_id uuid, reference_number text, status public.enquiry_status, client_identifier_conflict boolean, assigned_to uuid, assigned_to_name text, client_id uuid, client_name text, client_email text, client_phone text, client_instagram text, preferred_contact text, travelling_from text, project_type text, placement text, approximate_size text, cover_up text, preferred_timing text, idea text, source text, landing_page text, referrer text, utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, created_at timestamp with time zone, updated_at timestamp with time zone, last_action_at timestamp with time zone, reference_analyses jsonb, project_summary text, project_details jsonb)
language plpgsql
stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  return query
  select e.id, e.reference_number, e.status, e.client_identifier_conflict,
         e.assigned_to, p.display_name,
         e.client_id, cl.full_name, cl.email, cl.phone, cl.instagram,
         cl.preferred_contact, cl.travelling_from,
         e.project_type, e.placement, e.approximate_size, e.cover_up,
         e.preferred_timing, e.idea,
         e.source, e.landing_page, e.referrer,
         e.utm_source, e.utm_medium, e.utm_campaign, e.utm_content, e.utm_term,
         e.created_at, e.updated_at, e.last_action_at,
         crm_private.enquiry_reference_analyses(e.id),
         e.project_summary, e.project_details
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  left join public.profiles p on p.id = e.assigned_to
  where e.id = p_enquiry_id
    and e.artist_id = v_artist_id
    and e.intake_state = 'complete'
    and e.archived_at is null;
end;
$$;
revoke all on function public.gpt_get_enquiry_full(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_enquiry_full(uuid) to authenticated;
comment on function public.gpt_get_enquiry_full(uuid) is
  'Full enquiry for the active GPT Artist: client contact, form answers, the client''s original text, project_details (every body area, kind of work and style), project_summary and reference_analyses (stored vision analyses of the attached images with their role, unchanged).';

drop function if exists public.gpt_list_enquiry_files(uuid);
create function public.gpt_list_enquiry_files(p_enquiry_id uuid)
returns table(file_id uuid, ordinal smallint, category public.enquiry_file_category, original_filename text, mime_type text, byte_size bigint, upload_state public.enquiry_upload_state, uploaded_at timestamp with time zone, intake_role text)
language plpgsql
stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  return query
  select f.id, f.ordinal, f.category, f.original_filename, f.mime_type,
         f.byte_size, f.upload_state, f.uploaded_at, f.intake_role
  from public.enquiry_files f
  where f.enquiry_id = p_enquiry_id
  order by f.ordinal, f.id;
end;
$$;
revoke all on function public.gpt_list_enquiry_files(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_list_enquiry_files(uuid) to authenticated;
comment on function public.gpt_list_enquiry_files(uuid) is
  'Enquiry file manifests inside the GPT artist scope. intake_role is design_reference or existing_tattoo for booking form v2 images, NULL for legacy and staff uploads.';
