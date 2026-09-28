-- Switch on Instagram booking cards for artists whose Instagram account is
-- connected.
--
-- Applied only after the Instagram Worker's outbound drain is live, so a card
-- queued for Instagram can actually be delivered. Routing is unchanged: a card
-- goes to Instagram only when the client's newest real conversation is on
-- Instagram, only inside Meta's 24-hour window, and only for appointments
-- booked after the booking-card activation cutoff.

update crm_private.booking_card_artist_settings s
set instagram_enabled = true,
    updated_at = now()
where not s.instagram_enabled
  and exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = s.artist_id
      and i.integration_type = 'instagram'::public.artist_integration_type
      and i.provider = 'instagram_login'
      and i.is_enabled
  );
