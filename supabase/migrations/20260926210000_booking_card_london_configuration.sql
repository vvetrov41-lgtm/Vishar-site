-- 20260926210000_booking_card_london_configuration.sql
--
-- Production-ready London booking-card metadata for Vladimir and Kristina.
-- Email is enabled after the reviewed Gmail backend redeploy; WhatsApp remains
-- fail-closed until both Meta Utility templates are read back as APPROVED.
-- The November start cutoff prevents London details
-- from ever being attached to the remaining October Manchester appointments.

insert into crm_private.booking_card_artist_settings (
  artist_id,
  email_enabled,
  whatsapp_enabled,
  studio_name,
  studio_address,
  studio_map_url,
  location_latitude,
  location_longitude,
  whatsapp_tattoo_template_name,
  whatsapp_consultation_template_name,
  whatsapp_template_language,
  appointment_start_from,
  client_action_base_url
)
select
  a.id,
  true,
  false,
  'Label Tattoo Private',
  '16 Exhibition House, Addison Bridge Place, London W14 8XP',
  'https://www.google.com/maps/search/?api=1&query=16%20Exhibition%20House%2C%20Addison%20Bridge%20Place%2C%20London%20W14%208XP',
  51.494941,
  -0.206322,
  'booking_card_tattoo_v1',
  'booking_card_consultation_v1',
  'en_GB',
  '2026-11-01 00:00:00+00'::timestamptz,
  'https://booking.vishartattoo.com/appointments/respond/'
from public.artists a
where a.id in (
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'a2222222-2222-4222-8222-222222222222'::uuid
)
on conflict (artist_id) do update
set email_enabled = true,
    whatsapp_enabled = false,
    studio_name = excluded.studio_name,
    studio_address = excluded.studio_address,
    studio_map_url = excluded.studio_map_url,
    location_latitude = excluded.location_latitude,
    location_longitude = excluded.location_longitude,
    whatsapp_tattoo_template_name = excluded.whatsapp_tattoo_template_name,
    whatsapp_consultation_template_name = excluded.whatsapp_consultation_template_name,
    whatsapp_template_language = excluded.whatsapp_template_language,
    appointment_start_from = excluded.appointment_start_from,
    client_action_base_url = excluded.client_action_base_url,
    updated_at = now();
