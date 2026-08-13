-- 0038_manual_crm_enquiry_intake.sql
--
-- Private CRM-only intake for staff-entered enquiries before public booking
-- cutover. This path is authenticated, artist-scoped and deliberately does not
-- create file manifests, booking-source routing, outbox jobs or provider work.

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
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
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
    'email:' || v_email_norm,
    case when v_phone_norm is not null then 'phone:' || v_phone_norm end
  ]) as identifiers(identifier)
  where identifier is not null
  order by identifier;

  select c.id into v_email_client
  from public.clients c
  where c.email_normalized = v_email_norm
    and c.archived_at is null
  order by c.created_at, c.id
  limit 1
  for update;

  if v_phone_norm is not null then
    select c.id into v_phone_client
    from public.clients c
    where c.phone_normalized = v_phone_norm
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
      full_name, email, phone, instagram, preferred_contact, travelling_from
    ) values (
      v_full_name, v_email, v_phone, v_instagram, v_preferred_contact, v_travelling_from
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
    client_id,
    reference_number,
    idempotency_key,
    intake_fingerprint,
    status,
    intake_state,
    client_identifier_conflict,
    submitted_full_name,
    submitted_email,
    submitted_phone,
    submitted_instagram,
    submitted_preferred_contact,
    submitted_travelling_from,
    project_type,
    placement,
    approximate_size,
    cover_up,
    preferred_timing,
    idea,
    source,
    privacy_notice_version,
    privacy_acknowledged_at,
    artist_id,
    booking_source_id
  ) values (
    v_client_id,
    'PENDING',
    p_idempotency_key,
    v_fingerprint,
    'new',
    'complete',
    v_conflict,
    v_full_name,
    v_email,
    v_phone,
    v_instagram,
    v_preferred_contact,
    v_travelling_from,
    v_project_type,
    v_placement,
    v_approximate_size,
    v_cover_up,
    v_preferred_timing,
    v_idea,
    'crm_manual',
    v_privacy_version,
    now(),
    p_artist_id,
    null
  ) returning id, reference_number into v_enquiry_id, v_reference;

  if v_client_created then
    perform crm_private.log_artist_activity(
      p_artist_id,
      'client.created',
      v_actor_kind,
      auth.uid(),
      v_client_id,
      v_enquiry_id,
      null,
      null,
      null,
      jsonb_build_object('match_method', v_match_method, 'source', 'crm_manual')
    );
  end if;

  if v_conflict then
    perform crm_private.log_artist_activity(
      p_artist_id,
      'client.identifier_conflict',
      v_actor_kind,
      auth.uid(),
      v_client_id,
      v_enquiry_id,
      null,
      null,
      null,
      jsonb_build_object(
        'attached_to', 'email_match',
        'other_client_id', v_phone_client,
        'requires_review', true,
        'source', 'crm_manual'
      )
    );
  end if;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'enquiry.manual_created',
    v_actor_kind,
    auth.uid(),
    v_client_id,
    v_enquiry_id,
    null,
    null,
    null,
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

revoke all on function public.create_manual_enquiry(uuid, uuid, jsonb, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_manual_enquiry(uuid, uuid, jsonb, jsonb, boolean)
  to authenticated;

comment on function public.create_manual_enquiry(uuid, uuid, jsonb, jsonb, boolean) is
  'Authenticated CRM-only, artist-scoped manual enquiry creation. Requires staff confirmation of the current client privacy acknowledgement and creates no booking source, file manifest, outbox job or provider work.';
