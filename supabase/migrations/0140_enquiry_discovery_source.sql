-- 0140_enquiry_discovery_source.sql
--
-- Store a client's self-reported "how did you hear about us?" answer as
-- ordinary enquiry metadata. This is deliberately separate from booking source,
-- UTM and communication-channel attribution, none of which it may override.
--
-- Historical and legacy intake stays compatible: NULL means not recorded.
-- Forward-only.

alter table public.enquiries
  add column if not exists discovery_source text;

alter table public.enquiries
  add constraint enquiries_discovery_source_known
  check (
    discovery_source is null
    or discovery_source in (
      'instagram',
      'chatgpt',
      'other_ai',
      'friend_referral',
      'google',
      'other'
    )
  );

comment on column public.enquiries.discovery_source is
  'Client self-reported discovery category. Descriptive attribution only; never artist/source/provider routing authority. NULL means not recorded.';

-- All trusted external and hosted booking-source intake converges through this
-- helper (migration 0079). The legacy core create_enquiry_intake has an
-- intentionally explicit INSERT column list, so persist this additive field in
-- the same transaction here instead of duplicating that large security-critical
-- function. Its idempotency fingerprint already covers the complete p_enquiry
-- JSON, including discovery_source when present.
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
  v_discovery_source text := nullif(
    btrim(coalesce(p_enquiry ->> 'discovery_source', '')),
    ''
  );
begin
  if not crm_private.is_service_backend() then
    raise exception 'trusted enquiry intake is backend-only'
      using errcode = '42501';
  end if;

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

  -- The value is additive metadata on the enquiry. Only fill an empty value;
  -- an idempotent replay with a different payload has already been refused by
  -- create_enquiry_intake's payload fingerprint before this statement runs.
  if v_discovery_source is not null then
    update public.enquiries e
    set discovery_source = v_discovery_source
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