-- 20260928180000_booking_card_template_provider_error.sql
--
-- Automatic WhatsApp booking-card template provisioning recorded every Meta
-- 4xx as the generic whatsapp_template_rejected. Meta answers most template
-- failures with HTTP 400 (missing permission #200, invalid token #190,
-- duplicate content, policy), so production could not tell why Kristina's
-- templates were refused, or even whether listing or creating failed.
--
-- The worker now reports the failing stage and Meta's numeric code, subcode
-- and error type. Only that bounded, content-free shape is stored: no Meta
-- message text, no token, no request body.

alter table crm_private.booking_card_artist_settings
  add column if not exists whatsapp_template_last_provider_error jsonb;

alter table crm_private.booking_card_artist_settings
  drop constraint if exists booking_card_settings_template_provider_error_shape;

alter table crm_private.booking_card_artist_settings
  add constraint booking_card_settings_template_provider_error_shape
  check (
    whatsapp_template_last_provider_error is null
    or (
      jsonb_typeof(whatsapp_template_last_provider_error) = 'object'
      and whatsapp_template_last_provider_error - array['stage', 'http_status', 'code', 'subcode', 'type'] = '{}'::jsonb
      and octet_length(whatsapp_template_last_provider_error::text) <= 256
    )
  );

comment on column crm_private.booking_card_artist_settings.whatsapp_template_last_provider_error is
  'Last Meta template failure: stage, HTTP status, numeric code/subcode and error type only. Cleared on the next successful check.';

-- The previous four-argument signature is replaced so PostgREST sees exactly
-- one function; the new argument defaults to null, so the current worker's
-- call keeps working until the new worker is deployed.
drop function if exists public.service_record_booking_card_template_status(uuid, text, text, text);

create function public.service_record_booking_card_template_status(
  p_artist_id uuid,
  p_tattoo_status text,
  p_consultation_status text,
  p_error_code text default null,
  p_provider_error jsonb default null
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
      end
    ));
    if v_provider = '{}'::jsonb then
      v_provider := null;
    end if;
  end if;

  update crm_private.booking_card_artist_settings s
  set whatsapp_tattoo_template_status = v_tattoo,
      whatsapp_consultation_template_status = v_consultation,
      whatsapp_enabled = (
        v_tattoo = 'APPROVED'
        and v_consultation = 'APPROVED'
      ),
      whatsapp_template_last_error_code = v_error,
      whatsapp_template_last_provider_error = v_provider,
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
    'error_code', v_error,
    'provider_error', v_provider
  );
end;
$$;

revoke all on function public.service_record_booking_card_template_status(
  uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.service_record_booking_card_template_status(
  uuid, text, text, text, jsonb
) to service_role;
