-- 20260926200000_booking_card_template_maintenance.sql
--
-- Safe state for automatic Meta Utility-template provisioning/readback.
-- Provider credentials stay in artist-scoped Worker secrets; Postgres stores
-- only template names, safe provider statuses and the last safe error code.

alter table crm_private.booking_card_artist_settings
  add column if not exists whatsapp_tattoo_template_status text,
  add column if not exists whatsapp_consultation_template_status text,
  add column if not exists whatsapp_template_checked_at timestamptz,
  add column if not exists whatsapp_template_last_error_code text;

alter table crm_private.booking_card_artist_settings
  drop constraint if exists booking_card_settings_template_status_shape;

alter table crm_private.booking_card_artist_settings
  add constraint booking_card_settings_template_status_shape
  check (
    (whatsapp_tattoo_template_status is null
      or whatsapp_tattoo_template_status ~ '^[A-Z][A-Z_]{2,31}$')
    and
    (whatsapp_consultation_template_status is null
      or whatsapp_consultation_template_status ~ '^[A-Z][A-Z_]{2,31}$')
    and
    (whatsapp_template_last_error_code is null
      or whatsapp_template_last_error_code ~ '^[a-z][a-z0-9_]{2,63}$')
  );

alter table crm_private.booking_card_artist_settings
  drop constraint if exists booking_card_settings_whatsapp_ready;

alter table crm_private.booking_card_artist_settings
  add constraint booking_card_settings_whatsapp_ready
  check (
    not whatsapp_enabled
    or (
      nullif(btrim(studio_name), '') is not null
      and nullif(btrim(studio_address), '') is not null
      and studio_map_url ~ '^https://[^[:space:]]{1,1900}$'
      and location_latitude is not null
      and location_longitude is not null
      and whatsapp_tattoo_template_name is not null
      and whatsapp_consultation_template_name is not null
      and whatsapp_tattoo_template_status = 'APPROVED'
      and whatsapp_consultation_template_status = 'APPROVED'
    )
  );

comment on column crm_private.booking_card_artist_settings.whatsapp_tattoo_template_status is
  'Safe Meta status for the configured tattoo booking-card Utility template.';
comment on column crm_private.booking_card_artist_settings.whatsapp_consultation_template_status is
  'Safe Meta status for the configured consultation booking-card Utility template.';
comment on column crm_private.booking_card_artist_settings.whatsapp_template_checked_at is
  'Last provider readback attempt for the configured booking-card templates.';
comment on column crm_private.booking_card_artist_settings.whatsapp_template_last_error_code is
  'Safe machine code only. Provider response bodies and credentials are never stored.';

create or replace function public.service_claim_booking_card_template_targets(
  p_limit integer default 5
)
returns table (
  artist_id uuid,
  integration_key text,
  tattoo_template_name text,
  consultation_template_name text,
  template_language text,
  tattoo_template_status text,
  consultation_template_status text
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'booking-card template maintenance is backend-only'
      using errcode = '42501';
  end if;

  if p_limit < 1 or p_limit > 20 then
    raise exception 'booking-card template maintenance limit is invalid'
      using errcode = '22023';
  end if;

  return query
  with candidates as (
    select
      s.artist_id,
      i.integration_key,
      s.whatsapp_tattoo_template_name,
      s.whatsapp_consultation_template_name,
      s.whatsapp_template_language,
      s.whatsapp_tattoo_template_status,
      s.whatsapp_consultation_template_status
    from crm_private.booking_card_artist_settings s
    join public.artists a
      on a.id = s.artist_id
     and a.is_active
    join public.artist_integrations i
      on i.artist_id = s.artist_id
     and i.integration_type = 'whatsapp'::public.artist_integration_type
     and i.provider = 'meta_cloud_api'
     and i.is_enabled
    where s.whatsapp_tattoo_template_name is not null
      and s.whatsapp_consultation_template_name is not null
      and (
        s.whatsapp_tattoo_template_status is distinct from 'APPROVED'
        or s.whatsapp_consultation_template_status is distinct from 'APPROVED'
      )
      and (
        s.whatsapp_template_checked_at is null
        or s.whatsapp_template_checked_at <= now() - interval '30 minutes'
      )
      and not exists (
        select 1
        from public.artist_integrations other
        where other.artist_id = s.artist_id
          and other.integration_type = 'whatsapp'::public.artist_integration_type
          and other.provider = 'meta_cloud_api'
          and other.is_enabled
          and other.id <> i.id
      )
    order by coalesce(s.whatsapp_template_checked_at, '-infinity'::timestamptz),
             s.artist_id
    limit p_limit
    for update of s skip locked
  ),
  claimed as (
    update crm_private.booking_card_artist_settings s
    set whatsapp_template_checked_at = now(),
        updated_at = now()
    from candidates c
    where s.artist_id = c.artist_id
    returning
      c.artist_id,
      c.integration_key,
      c.whatsapp_tattoo_template_name,
      c.whatsapp_consultation_template_name,
      c.whatsapp_template_language,
      c.whatsapp_tattoo_template_status,
      c.whatsapp_consultation_template_status
  )
  select
    c.artist_id,
    c.integration_key,
    c.whatsapp_tattoo_template_name,
    c.whatsapp_consultation_template_name,
    c.whatsapp_template_language,
    c.whatsapp_tattoo_template_status,
    c.whatsapp_consultation_template_status
  from claimed c;
end;
$$;

revoke all on function public.service_claim_booking_card_template_targets(integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_booking_card_template_targets(integer)
  to service_role;

create or replace function public.service_record_booking_card_template_status(
  p_artist_id uuid,
  p_tattoo_status text,
  p_consultation_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_tattoo text := upper(btrim(coalesce(p_tattoo_status, '')));
  v_consultation text := upper(btrim(coalesce(p_consultation_status, '')));
  v_error text := nullif(btrim(coalesce(p_error_code, '')), '');
begin
  if not crm_private.is_service_backend() then
    raise exception 'booking-card template maintenance is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null
     or v_tattoo !~ '^[A-Z][A-Z_]{2,31}$'
     or v_consultation !~ '^[A-Z][A-Z_]{2,31}$'
     or (v_error is not null and v_error !~ '^[a-z][a-z0-9_]{2,63}$') then
    raise exception 'booking-card template status is invalid'
      using errcode = '22023';
  end if;

  update crm_private.booking_card_artist_settings s
  set whatsapp_tattoo_template_status = v_tattoo,
      whatsapp_consultation_template_status = v_consultation,
      whatsapp_enabled = (
        v_tattoo = 'APPROVED'
        and v_consultation = 'APPROVED'
      ),
      whatsapp_template_last_error_code = v_error,
      whatsapp_template_checked_at = now(),
      updated_at = now()
  where s.artist_id = p_artist_id
    and s.whatsapp_tattoo_template_name is not null
    and s.whatsapp_consultation_template_name is not null;

  if not found then
    raise exception 'booking-card template target is unavailable'
      using errcode = '23503';
  end if;

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'tattoo_status', v_tattoo,
    'consultation_status', v_consultation,
    'templates_approved', v_tattoo = 'APPROVED' and v_consultation = 'APPROVED',
    'error_code', v_error
  );
end;
$$;

revoke all on function public.service_record_booking_card_template_status(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.service_record_booking_card_template_status(
  uuid, text, text, text
) to service_role;
