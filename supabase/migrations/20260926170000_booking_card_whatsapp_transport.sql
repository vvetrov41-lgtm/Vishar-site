-- 20260926170000_booking_card_whatsapp_transport.sql
--
-- Private structured payload for WhatsApp booking-card Utility templates.
-- Ordinary text jobs continue through the existing WhatsApp path unchanged.

create table crm_private.booking_card_whatsapp_payloads (
  booking_card_id uuid primary key
    references crm_private.booking_cards(id) on delete restrict,
  communication_message_id uuid not null unique
    references public.communication_messages(id) on delete restrict,
  template_name text not null
    check (template_name ~ '^[a-z0-9_]{1,512}$'),
  template_language text not null
    check (template_language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  body_parameters jsonb not null
    check (
      jsonb_typeof(body_parameters) = 'array'
      and jsonb_array_length(body_parameters) between 1 and 10
    ),
  location_name text not null
    check (btrim(location_name) <> '' and char_length(location_name) <= 256),
  location_address text not null
    check (btrim(location_address) <> '' and char_length(location_address) <= 512),
  location_latitude numeric(9,6) not null
    check (location_latitude between -90 and 90),
  location_longitude numeric(9,6) not null
    check (location_longitude between -180 and 180),
  confirm_payload text not null
    check (confirm_payload ~ '^booking_action:[0-9a-f]{64}$'),
  reschedule_payload text not null
    check (reschedule_payload ~ '^booking_action:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint booking_card_whatsapp_distinct_actions
    check (confirm_payload <> reschedule_payload)
);

revoke all on table crm_private.booking_card_whatsapp_payloads
  from public, anon, authenticated, service_role;

comment on table crm_private.booking_card_whatsapp_payloads is
  'Private provider payload for one canonical WhatsApp booking card. Raw one-time capabilities are never exposed through CRM/browser APIs.';

create or replace function public.service_resolve_whatsapp_booking_card_payload(
  p_outbox_id uuid,
  p_worker_id text
)
returns table (
  is_booking_card boolean,
  booking_card_id uuid,
  communication_message_id uuid,
  artist_id uuid,
  template_name text,
  template_language text,
  body_parameters jsonb,
  location_name text,
  location_address text,
  location_latitude numeric,
  location_longitude numeric,
  confirm_payload text,
  reschedule_payload text,
  delivery_allowed boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp booking card resolution is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null
     or coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'valid WhatsApp lease identity is required'
      using errcode = '22023';
  end if;

  return query
  select
    m.message_type = 'template' as is_booking_card,
    p.booking_card_id,
    m.id,
    o.artist_id,
    p.template_name,
    p.template_language,
    p.body_parameters,
    p.location_name,
    p.location_address,
    p.location_latitude,
    p.location_longitude,
    p.confirm_payload,
    p.reschedule_payload,
    case
      when m.message_type <> 'template' then true
      else (
        p.booking_card_id is not null
        and b.superseded_at is null
        and b.artist_id = o.artist_id
        and b.client_id is not distinct from o.client_id
        and s.status = 'confirmed'::public.session_status
        and s.calendar_version = b.calendar_version
        and s.start_at > now()
        and m.status = 'queued'::public.communication_status
        and settings.whatsapp_enabled
        and settings.whatsapp_template_language = p.template_language
        and (
          (b.card_kind = 'tattoo_deposit_paid'
            and settings.whatsapp_tattoo_template_name = p.template_name)
          or
          (b.card_kind = 'consultation_booked'
            and settings.whatsapp_consultation_template_name = p.template_name)
        )
      )
    end as delivery_allowed
  from public.integration_outbox o
  join public.communication_messages m
    on m.id = o.communication_message_id
  left join crm_private.booking_card_whatsapp_payloads p
    on p.communication_message_id = m.id
  left join crm_private.booking_cards b
    on b.id = p.booking_card_id
  left join public.sessions s
    on s.id = b.session_id
  left join crm_private.booking_card_artist_settings settings
    on settings.artist_id = b.artist_id
  where o.id = p_outbox_id
    and o.kind = 'whatsapp_message'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status
    and o.leased_by = p_worker_id
    and o.lease_expires_at > now()
    and m.artist_id = o.artist_id
    and m.channel = 'whatsapp'::public.communication_channel;
end;
$$;

revoke all on function public.service_resolve_whatsapp_booking_card_payload(uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_resolve_whatsapp_booking_card_payload(uuid, text)
  to service_role;
