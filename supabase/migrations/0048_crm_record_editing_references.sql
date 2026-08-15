-- 0048_crm_record_editing_references.sql
--
-- Narrow authenticated workflows for correcting canonical client data,
-- updating enquiry project details, and attaching references after intake.
-- Submitted contact snapshots remain immutable. Storage remains private and
-- manifest-backed; this migration does not widen table grants or Storage RLS.

-- ---------------------------------------------------------------------------
-- Canonical client editing
-- ---------------------------------------------------------------------------

create or replace function public.update_client_details(
  p_client_id uuid,
  p_client jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client public.clients%rowtype;
  v_full_name text;
  v_email text;
  v_phone text;
  v_instagram text;
  v_preferred_contact text;
  v_travelling_from text;
  v_changed text[] := '{}'::text[];
  v_artist_id uuid;
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if p_client_id is null then
    raise exception 'client id is required' using errcode = '22023';
  end if;
  if p_client is null or jsonb_typeof(p_client) <> 'object' then
    raise exception 'client payload must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_client) as k(key)
    where key not in (
      'full_name', 'email', 'phone', 'instagram',
      'preferred_contact', 'travelling_from'
    )
  ) then
    raise exception 'client payload contains an unsupported field' using errcode = '22023';
  end if;

  select * into v_client
  from public.clients c
  where c.id = p_client_id
    and c.archived_at is null
  for update;

  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if not public.can_manage_client(p_client_id) then
    raise exception 'client is outside your managed artist scope' using errcode = '42501';
  end if;

  -- A shared client card affects every linked artist. A non-owner may edit it
  -- only when they manage every artist scope currently linked to that client.
  if not public.is_owner() and exists (
    select 1
    from (
      select e.artist_id from public.enquiries e where e.client_id = p_client_id
      union
      select p.artist_id from public.projects p where p.client_id = p_client_id
    ) scopes
    where not public.can_manage_artist(scopes.artist_id)
  ) then
    raise exception 'shared client requires manage access to every linked artist'
      using errcode = '42501';
  end if;

  v_full_name := case when p_client ? 'full_name'
    then left(btrim(coalesce(p_client ->> 'full_name', '')), 160)
    else v_client.full_name end;
  v_email := case when p_client ? 'email'
    then left(nullif(btrim(coalesce(p_client ->> 'email', '')), ''), 320)
    else v_client.email end;
  v_phone := case when p_client ? 'phone'
    then left(nullif(btrim(coalesce(p_client ->> 'phone', '')), ''), 80)
    else v_client.phone end;
  v_instagram := case when p_client ? 'instagram'
    then left(nullif(btrim(coalesce(p_client ->> 'instagram', '')), ''), 80)
    else v_client.instagram end;
  v_preferred_contact := case when p_client ? 'preferred_contact'
    then nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), '')
    else v_client.preferred_contact end;
  v_travelling_from := case when p_client ? 'travelling_from'
    then left(nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), ''), 160)
    else v_client.travelling_from end;

  if v_full_name = '' then
    raise exception 'client full_name is required' using errcode = '22023';
  end if;
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'client email is invalid' using errcode = '22023';
  end if;
  if v_preferred_contact is not null
     and v_preferred_contact not in ('Email', 'WhatsApp', 'Instagram') then
    raise exception 'preferred contact is not permitted' using errcode = '22023';
  end if;

  if v_full_name is distinct from v_client.full_name then v_changed := array_append(v_changed, 'full_name'); end if;
  if v_email is distinct from v_client.email then v_changed := array_append(v_changed, 'email'); end if;
  if v_phone is distinct from v_client.phone then v_changed := array_append(v_changed, 'phone'); end if;
  if v_instagram is distinct from v_client.instagram then v_changed := array_append(v_changed, 'instagram'); end if;
  if v_preferred_contact is distinct from v_client.preferred_contact then v_changed := array_append(v_changed, 'preferred_contact'); end if;
  if v_travelling_from is distinct from v_client.travelling_from then v_changed := array_append(v_changed, 'travelling_from'); end if;

  if cardinality(v_changed) > 0 then
    update public.clients c
    set full_name = v_full_name,
        email = v_email,
        phone = v_phone,
        instagram = v_instagram,
        preferred_contact = v_preferred_contact,
        travelling_from = v_travelling_from,
        updated_at = now()
    where c.id = p_client_id;

    v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
    for v_artist_id in
      select distinct artist_id
      from (
        select e.artist_id from public.enquiries e where e.client_id = p_client_id
        union all
        select p.artist_id from public.projects p where p.client_id = p_client_id
      ) scoped
    loop
      perform crm_private.log_artist_activity(
        v_artist_id,
        'client.updated',
        v_actor_kind,
        auth.uid(),
        p_client_id,
        null,
        null,
        null,
        null,
        jsonb_build_object('changed_fields', to_jsonb(v_changed))
      );
    end loop;
  end if;

  return jsonb_build_object(
    'client_id', p_client_id,
    'changed_fields', to_jsonb(v_changed)
  );
end;
$$;

revoke all on function public.update_client_details(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_client_details(uuid,jsonb)
  to authenticated;

comment on function public.update_client_details(uuid,jsonb) is
  'Artist-scoped canonical client edit. Submitted enquiry snapshots stay immutable; audit metadata records field names only, never contact values.';

-- ---------------------------------------------------------------------------
-- Enquiry project-detail editing
-- ---------------------------------------------------------------------------

create or replace function public.update_enquiry_details(
  p_enquiry_id uuid,
  p_enquiry jsonb
)
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

revoke all on function public.update_enquiry_details(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_enquiry_details(uuid,jsonb)
  to authenticated;

comment on function public.update_enquiry_details(uuid,jsonb) is
  'Artist-scoped edit of mutable project fields on an enquiry. Original submitted contact, privacy, source and idempotency evidence remain immutable.';

-- ---------------------------------------------------------------------------
-- Post-intake enquiry references
-- ---------------------------------------------------------------------------

create or replace function public.prepare_enquiry_reference_upload(
  p_enquiry_id uuid,
  p_original_filename text,
  p_mime_type text,
  p_byte_size bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_file_id uuid := gen_random_uuid();
  v_ordinal smallint;
  v_extension text;
  v_storage_path text;
  v_filename text;
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if p_enquiry_id is null then
    raise exception 'enquiry id is required' using errcode = '22023';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'reference image type is not permitted' using errcode = '22023';
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 4 * 1024 * 1024 then
    raise exception 'reference image must be between 1 byte and 4 MB' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('enquiry-reference:' || p_enquiry_id::text, 0));

  select * into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id
    and e.archived_at is null
  for update;

  if not found then
    raise exception 'enquiry not found' using errcode = 'P0002';
  end if;
  if v_enquiry.intake_state <> 'complete' then
    raise exception 'references can be added only after enquiry intake is complete' using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  select candidate::smallint into v_ordinal
  from generate_series(0, 2) candidate
  where not exists (
    select 1 from public.enquiry_files f
    where f.enquiry_id = p_enquiry_id and f.ordinal = candidate
  )
  order by candidate
  limit 1;

  if v_ordinal is null then
    raise exception 'an enquiry can have at most three reference images' using errcode = '23514';
  end if;

  v_extension := case p_mime_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
  end;
  v_filename := left(nullif(btrim(coalesce(p_original_filename, '')), ''), 255);
  v_storage_path := public.enquiry_file_storage_path(
    v_enquiry.client_id,
    p_enquiry_id,
    v_file_id,
    v_extension
  );

  insert into public.enquiry_files (
    id, enquiry_id, ordinal, category, storage_path,
    original_filename, safe_extension, mime_type, byte_size, upload_state
  ) values (
    v_file_id, p_enquiry_id, v_ordinal, 'reference', v_storage_path,
    v_filename, v_extension, p_mime_type, p_byte_size, 'pending'
  );

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    v_enquiry.artist_id,
    'enquiry.reference_upload_prepared',
    v_actor_kind,
    auth.uid(),
    v_enquiry.client_id,
    p_enquiry_id,
    null,
    null,
    null,
    jsonb_build_object(
      'file_id', v_file_id,
      'ordinal', v_ordinal,
      'mime_type', p_mime_type,
      'byte_size', p_byte_size
    )
  );

  return jsonb_build_object(
    'file_id', v_file_id,
    'enquiry_id', p_enquiry_id,
    'ordinal', v_ordinal,
    'storage_path', v_storage_path,
    'mime_type', p_mime_type,
    'byte_size', p_byte_size
  );
end;
$$;

create or replace function public.finalize_enquiry_reference_upload(
  p_file_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, storage
as $$
declare
  v_file public.enquiry_files%rowtype;
  v_enquiry public.enquiries%rowtype;
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  select f.* into v_file
  from public.enquiry_files f
  where f.id = p_file_id
  for update;

  if not found then
    raise exception 'reference manifest not found' using errcode = 'P0002';
  end if;

  select * into v_enquiry
  from public.enquiries e
  where e.id = v_file.enquiry_id
    and e.archived_at is null;

  if not found then
    raise exception 'enquiry not found' using errcode = 'P0002';
  end if;

  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if v_file.upload_state = 'ready' then
    return jsonb_build_object('file_id', p_file_id, 'ready', true, 'replayed', true);
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'crm-files' and o.name = v_file.storage_path
  ) then
    raise exception 'reference object is not present in private Storage' using errcode = '22023';
  end if;

  update public.enquiry_files f
  set upload_state = 'ready',
      uploaded_at = now()
  where f.id = p_file_id;

  update public.enquiries e
  set updated_at = now(), last_action_at = now()
  where e.id = v_enquiry.id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    v_enquiry.artist_id,
    'enquiry.reference_uploaded',
    v_actor_kind,
    auth.uid(),
    v_enquiry.client_id,
    v_enquiry.id,
    null,
    null,
    null,
    jsonb_build_object('file_id', p_file_id, 'ordinal', v_file.ordinal)
  );

  return jsonb_build_object('file_id', p_file_id, 'ready', true, 'replayed', false);
end;
$$;

create or replace function public.cancel_enquiry_reference_upload(
  p_file_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, storage
as $$
declare
  v_file public.enquiry_files%rowtype;
  v_enquiry public.enquiries%rowtype;
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  select f.* into v_file
  from public.enquiry_files f
  where f.id = p_file_id
  for update;

  if not found then
    return jsonb_build_object('file_id', p_file_id, 'cancelled', true, 'replayed', true);
  end if;

  select * into v_enquiry from public.enquiries e where e.id = v_file.enquiry_id;
  if not found then
    raise exception 'enquiry not found' using errcode = 'P0002';
  end if;
  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if v_file.upload_state = 'ready' then
    raise exception 'ready references must use the owner removal workflow' using errcode = '22023';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'crm-files' and o.name = v_file.storage_path
  ) then
    raise exception 'uploaded reference object exists; finalize it or remove it as owner'
      using errcode = '22023';
  end if;

  delete from public.enquiry_files f where f.id = p_file_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    v_enquiry.artist_id,
    'enquiry.reference_upload_cancelled',
    v_actor_kind,
    auth.uid(),
    v_enquiry.client_id,
    v_enquiry.id,
    null,
    null,
    null,
    jsonb_build_object('file_id', p_file_id, 'ordinal', v_file.ordinal)
  );

  return jsonb_build_object('file_id', p_file_id, 'cancelled', true, 'replayed', false);
end;
$$;

create or replace function public.remove_enquiry_reference_manifest(
  p_file_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, storage
as $$
declare
  v_file public.enquiry_files%rowtype;
  v_enquiry public.enquiries%rowtype;
begin
  if not public.is_owner() then
    raise exception 'only the owner can remove a stored reference' using errcode = '42501';
  end if;

  select f.* into v_file
  from public.enquiry_files f
  where f.id = p_file_id
  for update;

  if not found then
    return jsonb_build_object('file_id', p_file_id, 'removed', true, 'replayed', true);
  end if;

  select * into v_enquiry from public.enquiries e where e.id = v_file.enquiry_id;
  if not found then
    raise exception 'enquiry not found' using errcode = 'P0002';
  end if;
  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'crm-files' and o.name = v_file.storage_path
  ) then
    raise exception 'remove the private Storage object before deleting its manifest'
      using errcode = '22023';
  end if;

  delete from public.enquiry_files f where f.id = p_file_id;
  update public.enquiries e
  set updated_at = now(), last_action_at = now()
  where e.id = v_enquiry.id;

  perform crm_private.log_artist_activity(
    v_enquiry.artist_id,
    'enquiry.reference_removed',
    'owner',
    auth.uid(),
    v_enquiry.client_id,
    v_enquiry.id,
    null,
    null,
    null,
    jsonb_build_object('file_id', p_file_id, 'ordinal', v_file.ordinal)
  );

  return jsonb_build_object('file_id', p_file_id, 'removed', true, 'replayed', false);
end;
$$;

revoke all on function public.prepare_enquiry_reference_upload(uuid,text,text,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_enquiry_reference_upload(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_enquiry_reference_upload(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_enquiry_reference_manifest(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.prepare_enquiry_reference_upload(uuid,text,text,bigint)
  to authenticated;
grant execute on function public.finalize_enquiry_reference_upload(uuid)
  to authenticated;
grant execute on function public.cancel_enquiry_reference_upload(uuid)
  to authenticated;
grant execute on function public.remove_enquiry_reference_manifest(uuid)
  to authenticated;

comment on function public.prepare_enquiry_reference_upload(uuid,text,text,bigint) is
  'Creates an artist-scoped pending reference manifest and returns its canonical private Storage path. Maximum three references, 4 MB each.';
comment on function public.finalize_enquiry_reference_upload(uuid) is
  'Marks a post-intake reference ready only after its manifest-backed object exists in private Storage.';
comment on function public.cancel_enquiry_reference_upload(uuid) is
  'Removes a pending reference manifest only when no private Storage object exists.';
comment on function public.remove_enquiry_reference_manifest(uuid) is
  'Owner-only final step after the private Storage object has been deleted; removes the manifest and records audit activity.';
