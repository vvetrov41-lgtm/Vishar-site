-- 20260928233500_booking_card_template_restriction.sql
--
-- Kristina's automatic template provisioning fails with Meta code 100,
-- subcode 2494160: a WABA-level restriction on creating or updating message
-- templates, not a missing permission. Retrying every ~35 minutes cannot
-- clear it.
--
-- 1. The stored diagnostic also keeps Meta's error message (bounded, never
--    containing a template placeholder) and fbtrace_id, so the restriction
--    can be raised with Meta support.
-- 2. Meta's WABA health_status (can_send_message and each entity's error
--    code, description and suggested fix) is stored per artist on every
--    maintenance run, for comparison between artists.
-- 3. While the restriction is recorded, the target is claimed once a day
--    instead of every 30 minutes; a successful check clears it and normal
--    cadence resumes. WhatsApp messaging is untouched.
-- 4. WABAs with approved templates are re-read once a day (list and health
--    only, nothing created), and a restriction recorded before this release
--    is probed once immediately to capture Meta's message and trace id.

alter table crm_private.booking_card_artist_settings
  add column if not exists whatsapp_waba_health jsonb,
  add column if not exists whatsapp_waba_health_checked_at timestamptz;

alter table crm_private.booking_card_artist_settings
  drop constraint if exists booking_card_settings_waba_health_shape;
alter table crm_private.booking_card_artist_settings
  add constraint booking_card_settings_waba_health_shape
  check (
    whatsapp_waba_health is null
    or (
      jsonb_typeof(whatsapp_waba_health) = 'object'
      and whatsapp_waba_health - array['can_send_message', 'entities'] = '{}'::jsonb
      and octet_length(whatsapp_waba_health::text) <= 4096
    )
  );

comment on column crm_private.booking_card_artist_settings.whatsapp_waba_health is
  'Meta WABA health_status from the last template maintenance run: can_send_message and per-entity error code, description and suggested fix. No tokens.';

alter table crm_private.booking_card_artist_settings
  drop constraint if exists booking_card_settings_template_provider_error_shape;
alter table crm_private.booking_card_artist_settings
  add constraint booking_card_settings_template_provider_error_shape
  check (
    whatsapp_template_last_provider_error is null
    or (
      jsonb_typeof(whatsapp_template_last_provider_error) = 'object'
      and whatsapp_template_last_provider_error
        - array['stage', 'http_status', 'code', 'subcode', 'type', 'message', 'fbtrace_id'] = '{}'::jsonb
      and octet_length(whatsapp_template_last_provider_error::text) <= 768
    )
  );

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
          -- Meta's WABA-level template restriction (code 100, subcode
          -- 2494160) is not cleared by retrying: probe once a day instead
          -- of every cycle until it lifts.
          when (s.whatsapp_template_last_provider_error ->> 'code') = '100'
           and (s.whatsapp_template_last_provider_error ->> 'subcode') = '2494160'
            then interval '24 hours'
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

-- One immediate probe for a WABA whose restriction was recorded before the
-- message and trace id were kept, so they are captured after this release.
update crm_private.booking_card_artist_settings s
set whatsapp_template_checked_at = null
where (s.whatsapp_template_last_provider_error ->> 'code') = '100'
  and (s.whatsapp_template_last_provider_error ->> 'subcode') = '2494160'
  and not (s.whatsapp_template_last_provider_error ? 'fbtrace_id');

revoke all on function public.service_claim_booking_card_template_targets(integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_booking_card_template_targets(integer)
  to service_role;

drop function if exists public.service_record_booking_card_template_status(uuid, text, text, text, jsonb);

create function public.service_record_booking_card_template_status(
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
         and char_length(p_provider_error ->> 'message') between 1 and 300
         and (p_provider_error ->> 'message') !~ '[[:cntrl:]]'
         and position('{{' in (p_provider_error ->> 'message')) = 0
          then p_provider_error ->> 'message'
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

  update crm_private.booking_card_artist_settings s
  set whatsapp_tattoo_template_status = v_tattoo,
      whatsapp_consultation_template_status = v_consultation,
      whatsapp_enabled = (
        v_tattoo = 'APPROVED'
        and v_consultation = 'APPROVED'
      ),
      whatsapp_template_last_error_code = v_error,
      whatsapp_template_last_provider_error = v_provider,
      whatsapp_waba_health = case
        when jsonb_typeof(p_waba_health) = 'object'
         and p_waba_health - array['can_send_message', 'entities'] = '{}'::jsonb
         and octet_length(p_waba_health::text) <= 4096
          then p_waba_health
        else s.whatsapp_waba_health
      end,
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
