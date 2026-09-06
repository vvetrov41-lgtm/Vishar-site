-- 0141_enquiry_discovery_source_detail.sql
--
-- Normalise self-reported discovery categories for reporting and store optional
-- human detail separately from the category. Booking/source routing remains
-- authoritative elsewhere and must never depend on these descriptive fields.
--
-- Forward-only. The helper accepts the legacy 0140 values during rolling
-- deploys and canonicalises them before persistence.

alter table public.enquiries
  add column if not exists discovery_source_detail text;

alter table public.enquiries
  drop constraint if exists enquiries_discovery_source_known;

update public.enquiries
set discovery_source = case discovery_source
  when 'chatgpt' then 'ai'
  when 'other_ai' then 'ai'
  when 'friend_referral' then 'referral'
  when 'tattoo_convention' then 'convention'
  else discovery_source
end
where discovery_source in ('chatgpt', 'other_ai', 'friend_referral', 'tattoo_convention');

alter table public.enquiries
  add constraint enquiries_discovery_source_known
  check (
    discovery_source is null
    or discovery_source in (
      'instagram',
      'google',
      'ai',
      'referral',
      'convention',
      'returning_client',
      'other'
    )
  );

comment on column public.enquiries.discovery_source is
  'Client self-reported discovery category: instagram, google, ai, referral, convention, returning_client or other. Descriptive attribution only; never artist/source/provider routing authority. NULL means not recorded.';

comment on column public.enquiries.discovery_source_detail is
  'Optional free-text detail for self-reported discovery attribution, such as AI service, referrer name or an Other source. Never routing authority.';

create or replace function crm_private.create_enquiry_for_booking_source(
  p_booking_source_id uuid,
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
  v_source record;
  v_result jsonb;
  v_enquiry_id uuid;
  v_previous_context text;
  v_changed integer;
  v_discovery_source_raw text := nullif(
    btrim(coalesce(p_enquiry ->> 'discovery_source', '')),
    ''
  );
  v_discovery_source text;
  v_discovery_source_detail text := nullif(
    btrim(coalesce(p_enquiry ->> 'discovery_source_detail', '')),
    ''
  );
begin
  if not crm_private.is_service_backend() then
    raise exception 'trusted enquiry intake is backend-only'
      using errcode = '42501';
  end if;

  v_discovery_source := case v_discovery_source_raw
    when 'chatgpt' then 'ai'
    when 'other_ai' then 'ai'
    when 'friend_referral' then 'referral'
    when 'tattoo_convention' then 'convention'
    else v_discovery_source_raw
  end;

  select s.* into v_source
  from public.booking_sources s
  join crm_private.artist_state a on a.artist_id = s.artist_id
  where s.id = p_booking_source_id
    and s.is_active
    and a.is_active;

  if not found then
    raise exception 'booking source is inactive or unavailable'
      using errcode = '42501';
  end if;

  v_previous_context := pg_catalog.current_setting('crm.trusted_booking_source_id', true);
  perform set_config('crm.trusted_booking_source_id', v_source.id::text, true);

  begin
    v_result := public.create_enquiry_intake(
      p_idempotency_key,
      p_client,
      coalesce(p_enquiry, '{}'::jsonb) || jsonb_build_object(
        '_trusted_booking_source_id', v_source.id,
        '_trusted_artist_id', v_source.artist_id
      ),
      p_files
    );
  exception when others then
    perform set_config(
      'crm.trusted_booking_source_id',
      coalesce(v_previous_context, ''),
      true
    );
    raise;
  end;

  perform set_config(
    'crm.trusted_booking_source_id',
    coalesce(v_previous_context, ''),
    true
  );

  v_enquiry_id := (v_result ->> 'enquiry_id')::uuid;

  update public.enquiries e
  set booking_source_id = v_source.id
  where e.id = v_enquiry_id
    and e.artist_id = v_source.artist_id
    and e.booking_source_id is null;
  get diagnostics v_changed = row_count;

  if v_discovery_source is not null then
    update public.enquiries e
    set discovery_source = v_discovery_source,
        discovery_source_detail = v_discovery_source_detail
    where e.id = v_enquiry_id
      and e.artist_id = v_source.artist_id
      and e.discovery_source is null;
  end if;

  if not exists (
    select 1
    from public.enquiries e
    where e.id = v_enquiry_id
      and e.artist_id = v_source.artist_id
      and e.booking_source_id = v_source.id
      and e.discovery_source is not distinct from v_discovery_source
      and e.discovery_source_detail is not distinct from v_discovery_source_detail
  ) then
    raise exception 'intake replay does not match the trusted booking source or discovery attribution'
      using errcode = '23514';
  end if;

  if v_changed = 1 then
    perform crm_private.log_artist_activity(
      v_source.artist_id,
      'enquiry.source_resolved',
      'worker',
      null,
      (v_result ->> 'client_id')::uuid,
      v_enquiry_id,
      null,
      null,
      null,
      jsonb_build_object(
        'source_key', v_source.source_key,
        'source_kind', v_source.source_kind,
        'form_version', v_source.form_version
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'artist_id', v_source.artist_id,
    'booking_source_id', v_source.id,
    'trusted_source_key', v_source.source_key
  );
end;
$$;

revoke all on function crm_private.create_enquiry_for_booking_source(uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
