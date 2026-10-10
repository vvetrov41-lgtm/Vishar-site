-- 20261010170000_booking_card_template_account_capability.sql
--
-- Kristina's template provisioning still fails with Meta 100/2494160 after
-- her WABA health returned to AVAILABLE. The stored message is only
-- "Invalid parameter". Meta's WhatsApp tooling names the reason for this
-- WABA as SMB_ACCOUNT_NOT_ON_COEX: a WhatsApp Business app account that is
-- not on Cloud API coexistence, on which message templates cannot be
-- created or edited through the API. The byte-identical payload is APPROVED
-- on Vladimir's Cloud API WABA, so it is an account state, not a payload,
-- category, language or token-scope fault.
--
-- 1. The provider diagnostic also keeps Meta's user-facing title and text
--    (error_user_title / error_user_msg), bounded and placeholder-free like
--    the message, so the next account-level refusal is self-explaining.
-- 2. While 100/2494160 is recorded the target is re-probed every 3 hours
--    instead of once a day, so templates added by another path (WhatsApp
--    Manager, coexistence onboarding) are adopted and their Meta status is
--    recorded promptly. Every other failure keeps the 30-minute cadence.
-- 3. WhatsApp booking cards are enabled only when both templates are
--    APPROVED and Meta's WABA health says AVAILABLE overall and for every
--    reported entity. A failed health read uses the last stored health; no
--    stored health keeps cards disabled (fail-closed). Vladimir's stored
--    health is AVAILABLE for WABA, BUSINESS and APP, so his state is
--    unchanged.

alter table crm_private.booking_card_artist_settings
  drop constraint if exists booking_card_settings_template_provider_error_shape;
alter table crm_private.booking_card_artist_settings
  add constraint booking_card_settings_template_provider_error_shape
  check (
    whatsapp_template_last_provider_error is null
    or (
      jsonb_typeof(whatsapp_template_last_provider_error) = 'object'
      and whatsapp_template_last_provider_error
        - array[
          'stage', 'http_status', 'code', 'subcode', 'type', 'message',
          'user_title', 'user_message', 'fbtrace_id'
        ] = '{}'::jsonb
      and octet_length(whatsapp_template_last_provider_error::text) <= 2048
    )
  );

create or replace function crm_private.booking_card_waba_health_available(
  p_health jsonb
)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(
    jsonb_typeof(p_health) = 'object'
    and p_health ->> 'can_send_message' = 'AVAILABLE'
    and jsonb_typeof(p_health -> 'entities') = 'array'
    and not exists (
      select 1
      from jsonb_array_elements(p_health -> 'entities') e
      where e ->> 'can_send_message' is distinct from 'AVAILABLE'
    ),
    false
  );
$$;

comment on function crm_private.booking_card_waba_health_available(jsonb) is
  'True only when Meta WABA health is AVAILABLE overall and for every reported entity. Unknown or malformed health is false.';

revoke all on function crm_private.booking_card_waba_health_available(jsonb)
  from public, anon, authenticated, service_role;

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
        -- Approved WABAs are re-read once a day (list + health only; nothing
        -- is created when both templates exist) so their health is current.
        or s.whatsapp_waba_health_checked_at is null
        or s.whatsapp_waba_health_checked_at <= now() - interval '24 hours'
      )
      and (
        s.whatsapp_template_checked_at is null
        or s.whatsapp_template_checked_at <= now() - case
          -- The WABA cannot manage templates through the API (code 100,
          -- subcode 2494160). Retrying every cycle cannot clear it, but
          -- templates added by another path must be adopted promptly.
          when (s.whatsapp_template_last_provider_error ->> 'code') = '100'
           and (s.whatsapp_template_last_provider_error ->> 'subcode') = '2494160'
            then interval '3 hours'
          else interval '30 minutes'
        end
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
  p_error_code text default null,
  p_provider_error jsonb default null,
  p_waba_health jsonb default null
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
  v_provider jsonb;
  v_health jsonb;
  v_enabled boolean;
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

  -- Rebuild the diagnostic from validated scalars only; anything unexpected
  -- is dropped rather than stored. It is kept only alongside an error code.
  if v_error is not null and jsonb_typeof(p_provider_error) = 'object' then
    v_provider := jsonb_strip_nulls(jsonb_build_object(
      'stage', case
        when p_provider_error ->> 'stage' in ('list', 'create_tattoo', 'create_consultation', 'readback')
          then p_provider_error ->> 'stage'
      end,
      'http_status', case
        when jsonb_typeof(p_provider_error -> 'http_status') = 'number'
         and (p_provider_error ->> 'http_status') ~ '^[1-5][0-9]{2}$'
          then (p_provider_error ->> 'http_status')::integer
      end,
      'code', case
        when jsonb_typeof(p_provider_error -> 'code') = 'number'
         and (p_provider_error ->> 'code') ~ '^[0-9]{1,10}$'
          then (p_provider_error ->> 'code')::bigint
      end,
      'subcode', case
        when jsonb_typeof(p_provider_error -> 'subcode') = 'number'
         and (p_provider_error ->> 'subcode') ~ '^[0-9]{1,10}$'
          then (p_provider_error ->> 'subcode')::bigint
      end,
      'type', case
        when (p_provider_error ->> 'type') ~ '^[A-Za-z_]{1,64}$'
          then p_provider_error ->> 'type'
      end,
      'message', case
        when jsonb_typeof(p_provider_error -> 'message') = 'string'
         and octet_length(p_provider_error ->> 'message') between 1 and 300
         and (p_provider_error ->> 'message') !~ '[[:cntrl:]]'
         and position('{{' in (p_provider_error ->> 'message')) = 0
          then p_provider_error ->> 'message'
      end,
      'user_title', case
        when jsonb_typeof(p_provider_error -> 'user_title') = 'string'
         and octet_length(p_provider_error ->> 'user_title') between 1 and 300
         and (p_provider_error ->> 'user_title') !~ '[[:cntrl:]]'
         and position('{{' in (p_provider_error ->> 'user_title')) = 0
          then p_provider_error ->> 'user_title'
      end,
      'user_message', case
        when jsonb_typeof(p_provider_error -> 'user_message') = 'string'
         and octet_length(p_provider_error ->> 'user_message') between 1 and 300
         and (p_provider_error ->> 'user_message') !~ '[[:cntrl:]]'
         and position('{{' in (p_provider_error ->> 'user_message')) = 0
          then p_provider_error ->> 'user_message'
      end,
      'fbtrace_id', case
        when (p_provider_error ->> 'fbtrace_id') ~ '^[A-Za-z0-9_/+=-]{6,64}$'
          then p_provider_error ->> 'fbtrace_id'
      end
    ));
    if v_provider = '{}'::jsonb then
      v_provider := null;
    end if;
  end if;

  if jsonb_typeof(p_waba_health) = 'object'
     and p_waba_health - array['can_send_message', 'entities'] = '{}'::jsonb
     and octet_length(p_waba_health::text) <= 4096 then
    v_health := p_waba_health;
  else
    select s.whatsapp_waba_health into v_health
    from crm_private.booking_card_artist_settings s
    where s.artist_id = p_artist_id;
  end if;

  v_enabled := v_tattoo = 'APPROVED'
    and v_consultation = 'APPROVED'
    and crm_private.booking_card_waba_health_available(v_health);

  update crm_private.booking_card_artist_settings s
  set whatsapp_tattoo_template_status = v_tattoo,
      whatsapp_consultation_template_status = v_consultation,
      whatsapp_enabled = v_enabled,
      whatsapp_template_last_error_code = v_error,
      whatsapp_template_last_provider_error = v_provider,
      whatsapp_waba_health = v_health,
      -- The attempt time, so a failed health read does not re-claim an
      -- approved WABA every cycle.
      whatsapp_waba_health_checked_at = now(),
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
    'waba_available', crm_private.booking_card_waba_health_available(v_health),
    'whatsapp_enabled', v_enabled,
    'error_code', v_error,
    'provider_error', v_provider,
    'template_restricted', coalesce(
      (v_provider ->> 'code') = '100' and (v_provider ->> 'subcode') = '2494160',
      false
    )
  );
end;
$$;

revoke all on function public.service_record_booking_card_template_status(
  uuid, text, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.service_record_booking_card_template_status(
  uuid, text, text, text, jsonb, jsonb
) to service_role;

-- Kristina's restriction was last probed at 09:26 UTC on the old daily
-- cadence. Probe once on the next run so the new diagnostic is captured.
update crm_private.booking_card_artist_settings s
set whatsapp_template_checked_at = null
where (s.whatsapp_template_last_provider_error ->> 'code') = '100'
  and (s.whatsapp_template_last_provider_error ->> 'subcode') = '2494160';
