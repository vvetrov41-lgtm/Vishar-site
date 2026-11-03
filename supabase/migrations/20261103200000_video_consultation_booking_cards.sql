-- Add video consultation booking-card support after approved migration review.
-- Video and in-person consultations use the same financial-free card shape.
alter table crm_private.booking_cards drop constraint booking_cards_financial_shape;

alter table crm_private.booking_cards add constraint booking_cards_financial_shape check (
  (card_kind='consultation_booked'
    and appointment_type in ('in_person_consultation'::public.appointment_type,
                             'video_consultation'::public.appointment_type)
    and session_price is null and deposit_paid is null and remaining_balance is null)
  or
  (card_kind='tattoo_deposit_paid'
    and appointment_type='tattoo_session'::public.appointment_type
    and session_price > 0 and deposit_paid > 0
    and deposit_paid <= session_price and remaining_balance=session_price-deposit_paid)
);

alter table crm_private.booking_card_artist_settings
  add column whatsapp_video_template_name text,
  add column whatsapp_video_template_status text not null default 'UNKNOWN',
  add column whatsapp_video_template_checked_at timestamptz;
alter table crm_private.booking_card_artist_settings
  add constraint booking_card_video_template_name_shape check (
    whatsapp_video_template_name is null or (
      whatsapp_video_template_name ~ '^[a-z0-9_]+$'
      and char_length(whatsapp_video_template_name) <= 512)),
  add constraint booking_card_video_template_status_shape check (
    whatsapp_video_template_status ~ '^[A-Z][A-Z_]{2,31}$');

update crm_private.booking_card_artist_settings s
set whatsapp_video_template_name='booking_card_video_consultation_v1'
from public.artists a
where a.id=s.artist_id and a.slug in ('vladimir','kristina');
