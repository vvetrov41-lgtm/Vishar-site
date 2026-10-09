-- 20261009160000_structured_enquiry_intake_v2.sql
--
-- Structured public enquiry intake (booking form v2).
--
-- The multi-step booking form describes one project across several body
-- areas, each with its own kind of work (new, extension, cover-up, rework),
-- and sends two kinds of image: design references and photos of the existing
-- tattoo. This migration is additive and keeps every legacy caller working:
--
--   * enquiries.project_details  structured, server-normalised answers. NULL
--                                for every legacy enquiry. The legacy text
--                                columns (project_type, placement, ...) are
--                                still written, derived by the Worker, so the
--                                CRM, AI, GPT and Telegram readers keep working.
--   * enquiry_files.intake_role  'design_reference' or 'existing_tattoo' for a
--                                v2 upload, NULL for legacy and operator files.
--                                category stays 'reference' and the storage
--                                path shape is unchanged.
--   * up to six intake files     the Worker still caps the legacy form at
--                                three and keeps the 13 MB request bound.
--   * WhatsApp-only clients      an enquiry may omit email only when WhatsApp
--                                is the preferred reply and the phone
--                                normalises to E.164, so the client can still
--                                be matched and reached.
--
-- create_enquiry_intake is rebuilt from the production definition of
-- 20260923020000_country_aware_phone_normalisation.sql; only the four changes
-- above differ. Legacy payloads produce the same fingerprint as before, so
-- in-flight idempotent retries replay unchanged.

-- ---------------------------------------------------------------------------
-- 1. Columns and constraints
-- ---------------------------------------------------------------------------

alter table public.enquiries
  add column if not exists project_details jsonb;

alter table public.enquiries
  drop constraint if exists enquiries_project_details_shape;
alter table public.enquiries
  add constraint enquiries_project_details_shape
  check (
    project_details is null
    or (
      jsonb_typeof(project_details) = 'object'
      and pg_column_size(project_details) <= 16384
    )
  );

comment on column public.enquiries.project_details is
  'Structured booking-form v2 answers (schema, areas with placements and work types, styles, size notes, existing tattoo details), normalised by the intake Worker. NULL for legacy and manual enquiries. The client''s own idea text stays in idea.';

alter table public.enquiries
  alter column submitted_email drop not null;

alter table public.enquiries
  drop constraint if exists enquiries_submitted_contact_present;
alter table public.enquiries
  add constraint enquiries_submitted_contact_present
  check (
    submitted_email is not null
    or (submitted_preferred_contact = 'WhatsApp' and submitted_phone is not null)
  );

alter table public.enquiry_files
  add column if not exists intake_role text;

alter table public.enquiry_files
  drop constraint if exists enquiry_files_intake_role_known;
alter table public.enquiry_files
  add constraint enquiry_files_intake_role_known
  check (intake_role is null or intake_role in ('design_reference', 'existing_tattoo'));

comment on column public.enquiry_files.intake_role is
  'What the client said this intake image shows: design_reference or existing_tattoo. NULL for legacy intake and files added later by staff.';

alter table public.enquiry_files
  drop constraint if exists enquiry_files_ordinal_range;
alter table public.enquiry_files
  add constraint enquiry_files_ordinal_range
  check (ordinal >= 0 and ordinal <= 5);

-- authenticated reads these tables through column-level grants.
grant select (project_details) on public.enquiries to authenticated;
grant select (intake_role) on public.enquiry_files to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Intake RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_enquiry_intake(p_idempotency_key uuid, p_client jsonb, p_enquiry jsonb, p_files jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_artist_id uuid;
  v_workspace_id uuid;
  v_email_raw text;
  v_email_norm text;
  v_phone_norm text;
  v_full_name text;
  v_client_id uuid;
  v_email_client uuid;
  v_phone_client uuid;
  v_match_method text := 'created';
  v_conflict boolean := false;
  v_enquiry_id uuid;
  v_reference text;
  v_file jsonb;
  v_file_id uuid;
  v_file_ordinal integer := 0;
  v_file_count integer;
  v_files_out jsonb := '[]'::jsonb;
  v_existing public.enquiries%rowtype;
  v_fingerprint text;
  v_privacy_version text;
  v_project_details jsonb;
  v_intake_role text;
begin
  if p_idempotency_key is null then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  -- Hosted intake establishes the trusted booking source before calling this
  -- function. Direct legacy calls resolve to the same canonical legacy artist.
  v_artist_id := crm_private.legacy_default_artist_id();
  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = v_artist_id and a.is_active;
  if v_workspace_id is null then
    raise exception 'booking workspace is unavailable' using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  v_fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'client', coalesce(p_client, 'null'::jsonb),
          'enquiry', coalesce(p_enquiry, 'null'::jsonb),
          'files', coalesce(p_files, 'null'::jsonb)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  select * into v_existing from public.enquiries e where e.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.intake_fingerprint <> v_fingerprint then
      raise exception 'idempotency key was reused with a different intake payload'
        using errcode = '22023';
    end if;

    select coalesce(
      jsonb_agg(jsonb_build_object(
        'file_id', f.id,
        'ordinal', f.ordinal,
        'storage_path', f.storage_path,
        'upload_state', f.upload_state,
        'mime_type', f.mime_type,
        'safe_extension', f.safe_extension,
        'byte_size', f.byte_size,
        'checksum', f.checksum
      ) order by f.ordinal),
      '[]'::jsonb
    ) into v_files_out
    from public.enquiry_files f where f.enquiry_id = v_existing.id;

    return jsonb_build_object(
      'enquiry_id', v_existing.id,
      'client_id', v_existing.client_id,
      'reference_number', v_existing.reference_number,
      'intake_state', v_existing.intake_state,
      'replayed', true,
      'client_conflict', v_existing.client_identifier_conflict,
      'client_match_method', 'replay',
      'files', v_files_out
    );
  end if;

  v_full_name := btrim(coalesce(p_client ->> 'full_name', ''));
  if v_full_name = '' then
    raise exception 'client full_name is required' using errcode = '22023';
  end if;

  v_email_raw := nullif(btrim(coalesce(p_client ->> 'email', '')), '');
  v_email_norm := public.normalize_email(v_email_raw);
  v_phone_norm := crm_private.client_phone_e164(p_client ->> 'phone', p_client ->> 'travelling_from');

  -- Email may be omitted only by a WhatsApp-first client whose number is a
  -- matchable E.164 phone. A supplied but malformed email is never dropped.
  if v_email_norm is null then
    if v_email_raw is not null
       or coalesce(p_client ->> 'preferred_contact', '') <> 'WhatsApp'
       or v_phone_norm is null then
      raise exception 'a valid client email is required' using errcode = '22023';
    end if;
  end if;

  v_privacy_version := btrim(coalesce(p_enquiry ->> 'privacy_notice_version', ''));

  if coalesce(p_enquiry ->> 'privacy_acknowledged', '') <> 'true'
     or v_privacy_version not in ('2026-07-29', '2026-09-09', '2026-09-14') then
    raise exception 'the current privacy notice must be acknowledged'
      using errcode = '22023';
  end if;

  v_project_details := p_enquiry -> 'project_details';
  if v_project_details is not null and jsonb_typeof(v_project_details) = 'null' then
    v_project_details := null;
  end if;
  if v_project_details is not null and jsonb_typeof(v_project_details) <> 'object' then
    raise exception 'project details must be an object' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identifier, 0))
  from unnest(array[
    case when v_email_norm is not null
      then 'workspace:' || v_workspace_id::text || ':email:' || v_email_norm end,
    case when v_phone_norm is not null
      then 'workspace:' || v_workspace_id::text || ':phone:' || v_phone_norm end
  ]) as identifiers(identifier)
  where identifier is not null
  order by identifier;

  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'file descriptors must be an array' using errcode = '22023';
  end if;

  v_file_count := jsonb_array_length(p_files);
  if v_file_count < 1 or v_file_count > 6 then
    raise exception 'between 1 and 6 reference files are required, received %', v_file_count
      using errcode = '22023';
  end if;

  if v_email_norm is not null then
    select c.id into v_email_client
    from public.clients c
    where c.workspace_id = v_workspace_id
      and c.email_normalized = v_email_norm
      and c.archived_at is null
    order by c.created_at, c.id
    limit 1
    for update;
  end if;

  if v_phone_norm is not null then
    select c.id into v_phone_client
    from public.clients c
    where c.workspace_id = v_workspace_id
      and c.phone_normalized = v_phone_norm
      and c.archived_at is null
    order by c.created_at, c.id
    limit 1
    for update;
  end if;

  if v_email_client is not null and v_phone_client is not null
     and v_email_client <> v_phone_client then
    v_conflict := true;
    v_client_id := v_email_client;
    v_match_method := 'email_with_phone_conflict';
  elsif v_email_client is not null then
    v_client_id := v_email_client;
    v_match_method := 'email';
  elsif v_phone_client is not null then
    v_client_id := v_phone_client;
    v_match_method := 'phone';
  end if;

  if v_client_id is null then
    insert into public.clients (
      workspace_id, full_name, email, phone, instagram, preferred_contact, travelling_from
    ) values (
      v_workspace_id,
      left(v_full_name, 160),
      v_email_raw,
      nullif(btrim(coalesce(p_client ->> 'phone', '')), ''),
      nullif(btrim(coalesce(p_client ->> 'instagram', '')), ''),
      nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), ''),
      nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), '')
    ) returning id into v_client_id;

    perform crm_private.log_artist_activity(
      v_artist_id, 'client.created', 'worker', null,
      v_client_id, null, null, null, null,
      jsonb_build_object('match_method', v_match_method)
    );
  elsif not v_conflict then
    update public.clients c set
      email = coalesce(c.email, v_email_raw),
      phone = coalesce(c.phone, nullif(btrim(coalesce(p_client ->> 'phone', '')), '')),
      instagram = coalesce(c.instagram, nullif(btrim(coalesce(p_client ->> 'instagram', '')), '')),
      travelling_from = coalesce(c.travelling_from, nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), '')),
      preferred_contact = coalesce(c.preferred_contact, nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), ''))
    where c.id = v_client_id;
  end if;

  insert into public.enquiries (
    client_id, reference_number, idempotency_key, intake_fingerprint,
    status, intake_state, client_identifier_conflict,
    submitted_full_name, submitted_email, submitted_phone,
    submitted_instagram, submitted_preferred_contact, submitted_travelling_from,
    project_type, placement, approximate_size, cover_up, preferred_timing, idea,
    source, landing_page, referrer,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    privacy_notice_version, privacy_acknowledged_at,
    artist_id, project_details
  ) values (
    v_client_id, 'PENDING', p_idempotency_key, v_fingerprint,
    'new', 'files_pending', v_conflict,
    left(v_full_name, 160),
    left(v_email_raw, 320),
    left(nullif(btrim(coalesce(p_client ->> 'phone', '')), ''), 80),
    left(nullif(btrim(coalesce(p_client ->> 'instagram', '')), ''), 80),
    nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), ''),
    left(nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'project_type', '')), ''), 100),
    left(nullif(btrim(coalesce(p_enquiry ->> 'placement', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'approximate_size', '')), ''), 120),
    left(nullif(btrim(coalesce(p_enquiry ->> 'cover_up', '')), ''), 40),
    left(nullif(btrim(coalesce(p_enquiry ->> 'preferred_timing', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'idea', '')), ''), 4000),
    left(nullif(btrim(coalesce(p_enquiry ->> 'source', '')), ''), 200),
    left(nullif(btrim(coalesce(p_enquiry ->> 'landing_page', '')), ''), 500),
    left(nullif(btrim(coalesce(p_enquiry ->> 'referrer', '')), ''), 500),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_source', '')), ''), 120),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_medium', '')), ''), 120),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_campaign', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_content', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_term', '')), ''), 160),
    v_privacy_version,
    now(),
    v_artist_id,
    v_project_details
  ) returning id, reference_number into v_enquiry_id, v_reference;

  for v_file in select * from jsonb_array_elements(p_files) loop
    v_file_id := gen_random_uuid();
    v_intake_role := nullif(btrim(coalesce(v_file ->> 'intake_role', '')), '');

    insert into public.enquiry_files (
      id, enquiry_id, ordinal, category, storage_path, original_filename,
      safe_extension, mime_type, byte_size, checksum, upload_state, intake_role
    ) values (
      v_file_id,
      v_enquiry_id,
      v_file_ordinal,
      'reference',
      public.enquiry_file_storage_path(v_client_id, v_enquiry_id, v_file_id, v_file ->> 'safe_extension'),
      left(nullif(btrim(coalesce(v_file ->> 'original_filename', '')), ''), 255),
      v_file ->> 'safe_extension',
      v_file ->> 'mime_type',
      (v_file ->> 'byte_size')::bigint,
      nullif(btrim(coalesce(v_file ->> 'checksum', '')), ''),
      'pending',
      v_intake_role
    );

    v_files_out := v_files_out || jsonb_build_object(
      'file_id', v_file_id,
      'ordinal', v_file_ordinal,
      'storage_path', public.enquiry_file_storage_path(v_client_id, v_enquiry_id, v_file_id, v_file ->> 'safe_extension'),
      'upload_state', 'pending',
      'mime_type', v_file ->> 'mime_type',
      'safe_extension', v_file ->> 'safe_extension',
      'byte_size', (v_file ->> 'byte_size')::bigint,
      'checksum', nullif(btrim(coalesce(v_file ->> 'checksum', '')), '')
    );

    v_file_ordinal := v_file_ordinal + 1;
  end loop;

  perform crm_private.log_artist_activity(
    v_artist_id, 'enquiry.created', 'worker', null,
    v_client_id, v_enquiry_id, null, null, null,
    jsonb_build_object(
      'reference_number', v_reference,
      'file_count', v_file_count,
      'client_match_method', v_match_method
    )
  );

  if v_conflict then
    perform crm_private.log_artist_activity(
      v_artist_id, 'client.identifier_conflict', 'worker', null,
      v_client_id, v_enquiry_id, null, null, null,
      jsonb_build_object(
        'attached_to', 'email_match',
        'other_client_id', v_phone_client,
        'requires_review', true
      )
    );
  end if;

  return jsonb_build_object(
    'enquiry_id', v_enquiry_id,
    'client_id', v_client_id,
    'reference_number', v_reference,
    'intake_state', 'files_pending',
    'replayed', false,
    'client_conflict', v_conflict,
    'client_match_method', v_match_method,
    'files', v_files_out
  );
end;
$function$;
