-- 20261009230000_enquiry_file_body_areas.sql
--
-- Optional link from an enquiry image to the body areas it concerns, and
-- operator control over the image category.
--
--   Image 1  design_reference / Arm
--   Image 2  existing_tattoo  / Arm (forearm cover-up)
--   Image 3  design_reference / Leg
--
--   * enquiry_files.body_areas  text[] of booking form v2 region keys
--     ('arm', 'leg', ...). Empty = not linked (every existing image), several
--     = the photo concerns several areas. The client is never asked for it.
--     Storage paths, the bucket and its policies are unchanged.
--   * public.set_enquiry_file_classification(file, role, areas)
--     owner/booking_manager with artist manage access set or change the
--     category (design_reference / existing_tattoo / none) and the areas.
--     Audited; the stored vision analysis is not touched or re-run.
--   * GPT/MCP: reference_analyses images gain body_areas (labels);
--     gpt_list_enquiry_files gains body_areas. Additive only.

create or replace function crm_private.enquiry_v2_region_keys_valid(p_keys text[])
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, crm_private
as $$
  select p_keys is not null
    and cardinality(p_keys) <= (crm_private.enquiry_v2_catalogue() #>> '{limits,maxAreas}')::integer
    and cardinality(p_keys) = (select count(distinct k) from unnest(p_keys) k)
    and not exists (
      select 1 from unnest(p_keys) k
      where not exists (
        select 1 from jsonb_array_elements(crm_private.enquiry_v2_catalogue() -> 'regions') as _r(r)
        where r ->> 'key' = k
      )
    );
$$;

revoke all on function crm_private.enquiry_v2_region_keys_valid(text[])
  from public, anon, authenticated, service_role;

alter table public.enquiry_files
  add column if not exists body_areas text[] not null default '{}';

alter table public.enquiry_files
  drop constraint if exists enquiry_files_body_areas_known;
alter table public.enquiry_files
  add constraint enquiry_files_body_areas_known
  check (crm_private.enquiry_v2_region_keys_valid(body_areas));

comment on column public.enquiry_files.body_areas is
  'Booking form v2 region keys this image concerns (arm, leg, ...). Empty when not linked. Set by staff; never required from the client.';
comment on column public.enquiry_files.intake_role is
  'What this image shows: design_reference or existing_tattoo. Set by the client at intake (booking form v2) or by staff later; NULL when not classified.';

grant select (body_areas) on public.enquiry_files to authenticated;

-- Region keys to catalogue labels, in the given order.
create or replace function crm_private.enquiry_v2_region_labels(p_keys text[])
returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, crm_private
as $$
  select coalesce(jsonb_agg(r ->> 'label' order by u.n), '[]'::jsonb)
  from unnest(coalesce(p_keys, '{}')) with ordinality u(k, n)
  join jsonb_array_elements(crm_private.enquiry_v2_catalogue() -> 'regions') as _r(r) on r ->> 'key' = u.k;
$$;

revoke all on function crm_private.enquiry_v2_region_labels(text[])
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Operator classification
-- ---------------------------------------------------------------------------

create or replace function public.set_enquiry_file_classification(
  p_file_id uuid,
  p_intake_role text,
  p_body_areas text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_file public.enquiry_files%rowtype;
  v_enquiry public.enquiries%rowtype;
  v_role text := nullif(btrim(coalesce(p_intake_role, '')), '');
  v_areas text[] := coalesce(p_body_areas, '{}');
  v_changed text[] := '{}'::text[];
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if p_file_id is null then
    raise exception 'file id is required' using errcode = '22023';
  end if;
  if v_role is not null and v_role not in ('design_reference', 'existing_tattoo') then
    raise exception 'image category must be design_reference, existing_tattoo or empty' using errcode = '22023';
  end if;
  if not crm_private.enquiry_v2_region_keys_valid(v_areas) then
    raise exception 'unknown or repeated body area' using errcode = '22023';
  end if;

  select f.* into v_file from public.enquiry_files f where f.id = p_file_id for update;
  if not found then
    raise exception 'image not found' using errcode = 'P0002';
  end if;

  select * into v_enquiry from public.enquiries e
  where e.id = v_file.enquiry_id and e.archived_at is null;
  if not found then
    raise exception 'enquiry not found' using errcode = 'P0002';
  end if;

  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if v_role is distinct from v_file.intake_role then v_changed := array_append(v_changed, 'intake_role'); end if;
  if v_areas is distinct from v_file.body_areas then v_changed := array_append(v_changed, 'body_areas'); end if;

  if cardinality(v_changed) > 0 then
    update public.enquiry_files f
    set intake_role = v_role,
        body_areas = v_areas
    where f.id = p_file_id;

    v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
    perform crm_private.log_artist_activity(
      v_enquiry.artist_id,
      'enquiry.reference_classified',
      v_actor_kind,
      auth.uid(),
      v_enquiry.client_id,
      v_enquiry.id,
      null,
      null,
      null,
      jsonb_build_object(
        'file_id', p_file_id,
        'ordinal', v_file.ordinal,
        'changed_fields', to_jsonb(v_changed),
        'intake_role', v_role,
        'body_areas', to_jsonb(v_areas)
      )
    );
  end if;

  return jsonb_build_object(
    'file_id', p_file_id,
    'intake_role', v_role,
    'body_areas', to_jsonb(v_areas),
    'changed_fields', to_jsonb(v_changed)
  );
end;
$$;

revoke all on function public.set_enquiry_file_classification(uuid, text, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.set_enquiry_file_classification(uuid, text, text[])
  to authenticated;

comment on function public.set_enquiry_file_classification(uuid, text, text[]) is
  'Artist-scoped staff classification of an enquiry image: category (design_reference / existing_tattoo / none) and the body areas it concerns. Never touches Storage or the stored vision analysis.';

-- ---------------------------------------------------------------------------
-- GPT / MCP reads (rebuilt from 20261009220000; body_areas added)
-- ---------------------------------------------------------------------------

create or replace function crm_private.enquiry_reference_analyses(p_enquiry_id uuid)
returns jsonb
language sql
stable security definer
set search_path = pg_catalog, public, crm_private
as $$
  with ready as (
    select f.id, f.intake_role, f.body_areas, row_number() over (order by f.ordinal, f.id) as position,
           count(*) over () as total
    from public.enquiry_files f
    where f.enquiry_id = p_enquiry_id and f.upload_state = 'ready'
  ), photos as (
    select r.position, r.total, r.intake_role, r.body_areas, a.analysis, a.summary, a.model, a.analyzed_at
    from ready r
    left join public.enquiry_file_ai_analysis a on a.enquiry_file_id = r.id
  )
  select jsonb_build_object(
    'note', 'Stored vision-model analysis of the client''s attached photos, not re-summarised. Photos are numbered as in the CRM. Use them with the client''s own text when reviewing the request, references, cover-up and placement. The photos and the client''s words are authoritative; anything an analysis does not show is unknown. role is what the photo shows (design_reference or existing_tattoo) and body_areas the areas it concerns, as stated by the client or staff; either is absent when not classified.',
    'images', coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'image', p.position || ' of ' || p.total,
          'role', p.intake_role,
          'body_areas', case when cardinality(p.body_areas) > 0
            then crm_private.enquiry_v2_region_labels(p.body_areas) end,
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

drop function if exists public.gpt_list_enquiry_files(uuid);
create function public.gpt_list_enquiry_files(p_enquiry_id uuid)
returns table(file_id uuid, ordinal smallint, category public.enquiry_file_category, original_filename text, mime_type text, byte_size bigint, upload_state public.enquiry_upload_state, uploaded_at timestamp with time zone, intake_role text, body_areas jsonb)
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
         f.byte_size, f.upload_state, f.uploaded_at, f.intake_role,
         crm_private.enquiry_v2_region_labels(f.body_areas)
  from public.enquiry_files f
  where f.enquiry_id = p_enquiry_id
  order by f.ordinal, f.id;
end;
$$;
revoke all on function public.gpt_list_enquiry_files(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_list_enquiry_files(uuid) to authenticated;
comment on function public.gpt_list_enquiry_files(uuid) is
  'Enquiry file manifests inside the GPT artist scope. intake_role is design_reference, existing_tattoo or NULL; body_areas lists the body areas (labels) the image concerns, empty when not linked.';
