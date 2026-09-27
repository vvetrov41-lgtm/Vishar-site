-- 313_booking_card_london_configuration.sql

begin;
select no_plan();

select results_eq(
  $$
    select a.slug, s.email_enabled, s.whatsapp_enabled,
           s.studio_name, s.appointment_start_from
    from crm_private.booking_card_artist_settings s
    join public.artists a on a.id = s.artist_id
    where a.id in (
      'a1111111-1111-4111-8111-111111111111'::uuid,
      'a2222222-2222-4222-8222-222222222222'::uuid
    )
    order by a.slug
  $$,
  $$
    values
      ('kristina'::text, true, false, 'Label Tattoo Private'::text,
       '2026-11-01 00:00:00+00'::timestamptz),
      ('vladimir'::text, true, false, 'Label Tattoo Private'::text,
       '2026-11-01 00:00:00+00'::timestamptz)
  $$,
  'London Email cards are active while WhatsApp remains fail-closed pending Meta approval'
);

select ok(
  (select bool_and(
      studio_address = '16 Exhibition House, Addison Bridge Place, London W14 8XP'
      and location_latitude = 51.494941
      and location_longitude = -0.206322
      and whatsapp_tattoo_template_name = 'booking_card_tattoo_v1'
      and whatsapp_consultation_template_name = 'booking_card_consultation_v1'
      and whatsapp_template_language = 'en_GB'
    )
   from crm_private.booking_card_artist_settings
   where artist_id in (
     'a1111111-1111-4111-8111-111111111111'::uuid,
     'a2222222-2222-4222-8222-222222222222'::uuid
   )),
  'both artists use the same London card/location contract'
);

select * from finish();
rollback;
