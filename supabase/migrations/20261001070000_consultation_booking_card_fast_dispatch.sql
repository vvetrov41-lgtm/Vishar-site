-- 20261001070000_consultation_booking_card_fast_dispatch.sql
--
-- Consultation booking cards are complete at confirmation time: they have no
-- price/deposit follow-up edit to debounce. Keep the existing two-minute
-- debounce for tattoo cards, where time/price/deposit edits may arrive as a
-- short sequence. Unknown or malformed booking-card keys fail closed to the
-- existing two-minute delay.

create or replace function crm_private.delay_booking_card_outbox()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card_id_text text;
  v_card_kind text;
  v_delay interval := interval '2 minutes';
begin
  if new.dedupe_key like 'email:booking_card:%'
     or new.dedupe_key like 'whatsapp:booking_card:%' then
    v_card_id_text := substring(
      new.dedupe_key
      from '^[^:]+:booking_card:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
    );

    if v_card_id_text is not null then
      select b.card_kind
        into v_card_kind
      from crm_private.booking_cards b
      where b.id = v_card_id_text::uuid;
    end if;

    if v_card_kind = 'consultation_booked' then
      v_delay := interval '10 seconds';
    end if;

    new.next_attempt_at := greatest(
      coalesce(new.next_attempt_at, now()),
      now() + v_delay
    );
  end if;

  return new;
end;
$$;

revoke all on function crm_private.delay_booking_card_outbox()
  from public, anon, authenticated, service_role;
