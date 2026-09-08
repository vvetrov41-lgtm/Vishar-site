-- 20260908002000_workspace_client_intake.sql
--
-- Every path that creates or matches a client must decide the target workspace
-- before looking at identifiers. Equal email/phone values in independent
-- workspaces intentionally resolve to different client cards.

create or replace function public.create_manual_enquiry(
  p_idempotency_key uuid,
  p_artist_id uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_privacy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_existing public.enquiries%rowtype;
  v_workspace_id uuid;
  v_fingerprint text;
  v_full_name text;
  v_email text;
  v_email_norm text;
  v_phone text;
  v_phone_norm text;
  v_instagram text;
  v_preferred_contact text;
  v_travelling_from text;
  v_project_type text;
  v_placement text;
  v_approximate_size text;
  v_cover_up text;
  v_preferred_timing text;
  v_idea text;
  v_client_id uuid;
  v_email_client uuid;
  v_phone_client uuid;
  v_enquiry_id uuid;
  v_reference text;
  v_match_method text := 'created';
  v_conflict boolean := false;
  v_client_created boolean := false;
  v_actor_kind text;
  v_privacy_version constant text := '2026-07-29';
begin
  perform crm_private.require_role('owner', 'booking_manager');
  perform crm_private.require_active_artist(p_artist_id);
  perform crm_private.require_artist_access(p_artist_id, 'manage');
  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = p_artist_id and a.is_active;
  if v_workspace_id is null then
    raise exception 'artist workspace is unavailable' using errcode = '23503';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if p_client is null or jsonb_typeof(p_client) <> 'object' then
    raise exception 'client payload must be an object' using errcode = '22023';
  end if;
  if p_enquiry is null or jsonb_typeof(p_enquiry) <> 'object' then
    raise exception 'enquiry payload must be an object' using errcode = '22023';
  end if;
  if coalesce(p_privacy_acknowledged, false) is not true then
    raise exception 'staff must confirm that the client acknowledged the current privacy notice'
      using errcode = '22023';
  end if;

  v_full_name := left(btrim(coalesce(p_client ->> 'full_name', '')), 160);
  v_email := left(btrim(coalesce(p_client ->> 'email', '')), 320);
  v_phone := left(nullif(btrim(coalesce(p_client ->> 'phone', '')), ''), 80);
  v_instagram := left(nullif(btrim(coalesce(p_client ->> 'instagram', '')), ''), 80);
  v_preferred_contact := nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), '');
  v_travelling_from := left(nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), ''), 160);

  v_project_type := left(nullif(btrim(coalesce(p_enquiry ->> 'project_type', '')), ''), 100);
  v_placement := left(nullif(btrim(coalesce(p_enquiry ->> 'placement', '')), ''), 160);
  v_approximate_size := left(nullif(btrim(coalesce(p_enquiry ->> 'approximate_size', '')), ''), 120);
  v_cover_up := left(nullif(btrim(coalesce(p_enquiry ->> 'cover_up', '')), ''), 40);
  v_preferred_timing := left(nullif(btrim(coalesce(p_enquiry ->> 'preferred_timing', '')), ''), 160);
  v_idea := left(nullif(btrim(coalesce(p_enquiry ->> 'idea', '')), ''), 4000);

  if v_full_name = '' then
    raise exception 'client full_name is required' using errcode = '22023';
  end if;

  v_email_norm := public.normalize_email(v_email);
  if v_email_norm is null
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' then
    raise exception 'a valid client email is required' using errcode = '22023';
  end if;

  v_phone_norm := public.normalize_phone(v_phone);
  if v_preferred_contact is not null
     and v_preferred_contact not in ('Email', 'WhatsApp', 'Instagram') then
    raise exception 'preferred contact is not permitted' using errcode = '22023';
  end if;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'artist_id', p_artist_id,
          'client', jsonb_build_object(
            'full_name', v_full_name,
            'email', v_email,
            'phone', v_phone,
            'instagram', v_instagram,
            'preferred_contact', v_preferred_contact,
            'travelling_from', v_travelling_from
          ),
          'enquiry', jsonb_build_object(
            'project_type', v_project_type,
            'placement', v_placement,
            'approximate_size', v_approximate_size,
            'cover_up', v_cover_up,
            'preferred_timing', v_preferred_timing,
            'idea', v_idea
          ),
          'privacy_notice_version', v_privacy_version,
          'privacy_acknowledged', true
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select e.* into v_existing
  from public.enquiries e
  where e.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.intake_fingerprint <> v_fingerprint
       or v_existing.artist_id <> p_artist_id
       or v_existing.source is distinct from 'crm_manual'
       or v_existing.booking_source_id is not null then
      raise exception 'idempotency key was reused with a different manual intake payload'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'enquiry_id', v_existing.id,
      'client_id', v_existing.client_id,
      'reference_number', v_existing.reference_number,
      'intake_state', v_existing.intake_state,
      'replayed', true,
      'client_conflict', v_existing.client_identifier_conflict,
      'client_match_method', 'replay'
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identifier, 0))
  from unnest(array[
    'workspace:' || v_workspace_id::text || ':email:' || v_email_norm,
    case when v_phone_norm is not null
      then 'workspace:' || v_workspace_id::text || ':phone:' || v_phone_norm end
  ]) as identifiers(identifier)
  where identifier is not null
  order by identifier;

  select c.id into v_email_client
  from public.clients c
  where c.workspace_id = v_workspace_id
    and c.email_normalized = v_email_norm
    and c.archived_at is null
  order by c.created_at, c.id
  limit 1
  for update;

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

  if v_email_client is not null
     and v_phone_client is not null
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
      v_workspace_id, v_full_name, v_email, v_phone, v_instagram, v_preferred_contact, v_travelling_from
    ) returning id into v_client_id;
    v_client_created := true;
  elsif not v_conflict then
    update public.clients c
    set email = coalesce(c.email, v_email),
        phone = coalesce(c.phone, v_phone),
        instagram = coalesce(c.instagram, v_instagram),
        preferred_contact = coalesce(c.preferred_contact, v_preferred_contact),
        travelling_from = coalesce(c.travelling_from, v_travelling_from)
    where c.id = v_client_id;
  end if;

  insert into public.enquiries (
    client_id, reference_number, idempotency_key, intake_fingerprint,
    status, intake_state, client_identifier_conflict,
    submitted_full_name, submitted_email, submitted_phone,
    submitted_instagram, submitted_preferred_contact, submitted_travelling_from,
    project_type, placement, approximate_size, cover_up, preferred_timing, idea,
    source, privacy_notice_version, privacy_acknowledged_at,
    artist_id, booking_source_id
  ) values (
    v_client_id, 'PENDING', p_idempotency_key, v_fingerprint,
    'new', 'complete', v_conflict,
    v_full_name, v_email, v_phone, v_instagram, v_preferred_contact, v_travelling_from,
    v_project_type, v_placement, v_approximate_size, v_cover_up, v_preferred_timing, v_idea,
    'crm_manual', v_privacy_version, now(),
    p_artist_id, null
  ) returning id, reference_number into v_enquiry_id, v_reference;

  if v_client_created then
    perform crm_private.log_artist_activity(
      p_artist_id, 'client.created', v_actor_kind, auth.uid(),
      v_client_id, v_enquiry_id, null, null, null,
      jsonb_build_object('match_method', v_match_method, 'source', 'crm_manual')
    );
  end if;

  if v_conflict then
    perform crm_private.log_artist_activity(
      p_artist_id, 'client.identifier_conflict', v_actor_kind, auth.uid(),
      v_client_id, v_enquiry_id, null, null, null,
      jsonb_build_object(
        'attached_to', 'email_match',
        'other_client_id', v_phone_client,
        'requires_review', true,
        'source', 'crm_manual'
      )
    );
  end if;

  perform crm_private.log_artist_activity(
    p_artist_id, 'enquiry.manual_created', v_actor_kind, auth.uid(),
    v_client_id, v_enquiry_id, null, null, null,
    jsonb_build_object(
      'reference_number', v_reference,
      'client_match_method', v_match_method,
      'privacy_notice_version', v_privacy_version,
      'privacy_acknowledgement_recorded_by_staff', true
    )
  );

  return jsonb_build_object(
    'enquiry_id', v_enquiry_id,
    'client_id', v_client_id,
    'reference_number', v_reference,
    'intake_state', 'complete',
    'replayed', false,
    'client_conflict', v_conflict,
    'client_match_method', v_match_method
  );
end;
$$;

create or replace function public.create_enquiry_intake(
  p_idempotency_key uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_workspace_id uuid;
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

  v_email_norm := public.normalize_email(p_client ->> 'email');
  if v_email_norm is null then
    raise exception 'a valid client email is required' using errcode = '22023';
  end if;

  v_phone_norm := public.normalize_phone(p_client ->> 'phone');
  v_privacy_version := btrim(coalesce(p_enquiry ->> 'privacy_notice_version', ''));

  if coalesce(p_enquiry ->> 'privacy_acknowledged', '') <> 'true'
     or v_privacy_version <> '2026-07-29' then
    raise exception 'the current privacy notice must be acknowledged'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identifier, 0))
  from unnest(array[
    'workspace:' || v_workspace_id::text || ':email:' || v_email_norm,
    case when v_phone_norm is not null
      then 'workspace:' || v_workspace_id::text || ':phone:' || v_phone_norm end
  ]) as identifiers(identifier)
  where identifier is not null
  order by identifier;

  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'file descriptors must be an array' using errcode = '22023';
  end if;

  v_file_count := jsonb_array_length(p_files);
  if v_file_count < 1 or v_file_count > 3 then
    raise exception 'between 1 and 3 reference files are required, received %', v_file_count
      using errcode = '22023';
  end if;

  select c.id into v_email_client
  from public.clients c
  where c.workspace_id = v_workspace_id
    and c.email_normalized = v_email_norm
    and c.archived_at is null
  order by c.created_at, c.id
  limit 1
  for update;

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
      nullif(btrim(coalesce(p_client ->> 'email', '')), ''),
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
      email = coalesce(c.email, nullif(btrim(coalesce(p_client ->> 'email', '')), '')),
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
    artist_id
  ) values (
    v_client_id, 'PENDING', p_idempotency_key, v_fingerprint,
    'new', 'files_pending', v_conflict,
    left(v_full_name, 160),
    left(btrim(p_client ->> 'email'), 320),
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
    v_artist_id
  ) returning id, reference_number into v_enquiry_id, v_reference;

  for v_file in select * from jsonb_array_elements(p_files) loop
    v_file_id := gen_random_uuid();

    insert into public.enquiry_files (
      id, enquiry_id, ordinal, category, storage_path, original_filename,
      safe_extension, mime_type, byte_size, checksum, upload_state
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
      'pending'
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
$$;

-- A client created from Inbox belongs to the conversation artist's workspace.
create or replace function public.create_client_from_communication(
  p_conversation_id uuid,
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_instagram text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
  v_workspace_id uuid;
  v_full_name text;
  v_email text;
  v_phone text;
  v_instagram text;
  v_client_id uuid;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id
  for update;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  perform crm_private.require_active_artist(v_conversation.artist_id);
  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');

  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = v_conversation.artist_id;
  if v_workspace_id is null then
    raise exception 'conversation workspace is unavailable' using errcode = '23503';
  end if;

  if v_conversation.client_id is not null then
    raise exception 'this conversation is already linked to a client'
      using errcode = '23514';
  end if;

  v_full_name := left(btrim(coalesce(p_full_name, '')), 160);
  if v_full_name = '' then
    raise exception 'a client name is required' using errcode = '22023';
  end if;

  v_email := left(nullif(btrim(coalesce(p_email, '')), ''), 320);
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' then
    raise exception 'that email address is not valid' using errcode = '22023';
  end if;

  v_phone := left(nullif(btrim(coalesce(p_phone, '')), ''), 80);
  v_instagram := left(nullif(btrim(coalesce(p_instagram, '')), ''), 80);

  if v_instagram is null
     and v_conversation.channel = 'instagram'::public.communication_channel
     and v_conversation.external_username is not null then
    v_instagram := '@' || v_conversation.external_username;
  end if;

  insert into public.clients (workspace_id, full_name, email, phone, instagram)
  values (v_workspace_id, v_full_name, v_email, v_phone, v_instagram)
  returning id into v_client_id;

  update public.communication_conversations c
  set client_id = v_client_id,
      link_state = 'linked'::public.communication_link_state,
      updated_at = now()
  where c.id = v_conversation.id;

  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    'communication.client_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_client_id,
    null, null, null, null,
    jsonb_build_object(
      'channel', v_conversation.channel,
      'conversation', v_conversation.id
    )
  );

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'client_id', v_client_id,
    'link_state', 'linked'
  );
end;
$$;

-- Existing grants remain unchanged by CREATE OR REPLACE, but state the boundary
-- explicitly so future migration refactors cannot accidentally widen it.
revoke all on function public.create_manual_enquiry(uuid,uuid,jsonb,jsonb,boolean)
  from public, anon, service_role;
grant execute on function public.create_manual_enquiry(uuid,uuid,jsonb,jsonb,boolean)
  to authenticated;
