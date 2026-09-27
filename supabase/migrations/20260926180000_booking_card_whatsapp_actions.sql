-- 20260926180000_booking_card_whatsapp_actions.sql
--
-- Apply booking-card quick replies atomically with inbound-message ingestion.
-- Signed webhook routing supplies the artist/integration/contact identity; the
-- opaque payload only carries the one-time appointment capability.

create or replace function public.service_apply_whatsapp_booking_card_action(
  p_artist_id uuid,
  p_integration_key text,
  p_contact_wa_id text,
  p_provider_message_id text,
  p_provider_timestamp timestamptz,
  p_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_token text;
  v_hash text;
  v_session_id uuid;
  v_action public.appointment_client_action;
  v_client_id uuid;
  v_client_phone text;
  v_ingest jsonb;
  v_apply jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp booking action is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null
     or coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$'
     or coalesce(p_contact_wa_id, '') !~ '^[0-9]{6,20}$'
     or coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$'
     or p_provider_timestamp is null
     or p_provider_timestamp > now() + interval '5 minutes'
     or coalesce(p_payload, '') !~ '^booking_action:[0-9a-f]{64}$' then
    raise exception 'invalid WhatsApp booking action envelope'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'whatsapp'::public.artist_integration_type
      and i.provider = 'meta_cloud_api'
      and i.integration_key = p_integration_key
      and i.is_enabled
  ) then
    raise exception 'artist WhatsApp route is unavailable'
      using errcode = '23503';
  end if;

  v_token := substring(p_payload from 16);
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  select
    t.session_id,
    t.action,
    s.client_id,
    crm_private.normalize_whatsapp_phone(c.phone)
  into
    v_session_id,
    v_action,
    v_client_id,
    v_client_phone
  from crm_private.appointment_client_action_tokens t
  join public.sessions s on s.id = t.session_id
  join public.clients c on c.id = s.client_id and c.archived_at is null
  where t.token_hash = v_hash
    and t.action in (
      'confirm_attendance'::public.appointment_client_action,
      'request_reschedule'::public.appointment_client_action
    )
    and s.artist_id = p_artist_id
    and s.status = 'confirmed'::public.session_status
    and s.start_at > now()
    and t.session_calendar_version = s.calendar_version
    and t.expires_at > now()
    and t.consumed_at is null
    and t.invalidated_at is null;

  if not found or v_client_phone is distinct from '+' || p_contact_wa_id then
    return jsonb_build_object(
      'applied', false,
      'reason', 'action_unavailable'
    );
  end if;

  -- Inbound persistence and action application live in this one transaction.
  -- If applying the appointment capability fails, the provider message insert
  -- rolls back too, so Meta can safely retry the same webhook.
  v_ingest := public.record_whatsapp_inbound_message(
    p_artist_id,
    p_integration_key,
    p_contact_wa_id,
    p_provider_message_id,
    p_provider_timestamp,
    'button',
    null
  );

  if coalesce((v_ingest ->> 'changed')::boolean, false) is false then
    return jsonb_build_object(
      'applied', false,
      'replayed', true,
      'reason', 'provider_event_replayed'
    );
  end if;

  v_apply := public.service_apply_appointment_client_action(v_token);

  return jsonb_build_object(
    'applied', true,
    'replayed', false,
    'action', v_apply ->> 'action',
    'outcome', v_apply ->> 'outcome'
  );
end;
$$;

revoke all on function public.service_apply_whatsapp_booking_card_action(
  uuid, text, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.service_apply_whatsapp_booking_card_action(
  uuid, text, text, text, timestamptz, text
) to service_role;

comment on function public.service_apply_whatsapp_booking_card_action(
  uuid, text, text, text, timestamptz, text
) is
  'Backend-only signed-webhook bridge for booking-card quick replies. Validates artist/contact ownership, persists the inbound button idempotently and applies the existing one-time appointment capability atomically.';
