-- 20261009200000_enquiry_reference_six_slots.sql
--
-- Operator CRM can attach up to six reference images to an existing enquiry.
--
-- 20261009160000 widened enquiry_files_ordinal_range to 0..5 so booking form
-- v2 can send six intake images, but prepare_enquiry_reference_upload still
-- searched only ordinals 0..2. An operator adding a fourth image to any
-- enquiry got "at most three reference images" although the CRM offered six
-- slots.
--
-- The function is rebuilt from the production definition (identical to
-- 0048_crm_record_editing_references.sql). Only the free-slot search range,
-- the limit message and the comment change. Unchanged on purpose:
--   * role, active-artist and artist 'manage' checks;
--   * per-enquiry advisory lock plus FOR UPDATE on the enquiry, so parallel
--     uploads still serialise and cannot claim the same ordinal;
--   * the unique (enquiry_id, ordinal) key as the final guard;
--   * MIME allowlist and 4 MB size limit (same as the crm-files bucket);
--   * canonical Storage path, pending manifest, finalize/cancel/remove flow;
--   * ACL: authenticated only, then checked inside the function.
-- Six is the product ceiling and matches the ordinal CHECK; a seventh image
-- is rejected with 23514 as before.

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
  from generate_series(0, 5) candidate
  where not exists (
    select 1 from public.enquiry_files f
    where f.enquiry_id = p_enquiry_id and f.ordinal = candidate
  )
  order by candidate
  limit 1;

  if v_ordinal is null then
    raise exception 'an enquiry can have at most six reference images' using errcode = '23514';
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

revoke all on function public.prepare_enquiry_reference_upload(uuid,text,text,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_enquiry_reference_upload(uuid,text,text,bigint)
  to authenticated;

comment on function public.prepare_enquiry_reference_upload(uuid,text,text,bigint) is
  'Creates an artist-scoped pending reference manifest and returns its canonical private Storage path. Maximum six references (ordinals 0-5), 4 MB each.';
