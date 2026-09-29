-- 20260929090000_booking_card_template_health_reprobe.sql
--
-- 20260928234000 cleared Kristina's check time so the first run after the
-- release would capture Meta's message, fbtrace_id and WABA health. The
-- migration was released at 05:00 UTC, but the WhatsApp drain Worker that
-- records those fields was deployed only at 08:29 UTC, so the probe ran on
-- the previous Worker: nothing new was stored and both WABAs entered the
-- 24-hour cadence.
--
-- Any artist whose WABA health has never been recorded is checked once more
-- on the next run. Nothing else changes; the daily cadence applies again
-- afterwards.

update crm_private.booking_card_artist_settings s
set whatsapp_template_checked_at = null,
    whatsapp_waba_health_checked_at = null
where s.whatsapp_waba_health is null
  and s.whatsapp_tattoo_template_name is not null
  and s.whatsapp_consultation_template_name is not null;
