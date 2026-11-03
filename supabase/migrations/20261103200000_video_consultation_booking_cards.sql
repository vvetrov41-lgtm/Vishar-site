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

CREATE OR REPLACE FUNCTION crm_private.booking_card_eligibility(p_session_id uuid)
 RETURNS TABLE(eligible boolean, reason text, card_kind text, session_price numeric, deposit_paid numeric, remaining_balance numeric, currency text, deposit_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_session record;
  v_deposit numeric;
  v_deposit_currency text;
  v_deposit_source text;
begin
  select s.appointment_type, s.status, s.start_at, s.price, s.currency, s.created_at,
         a.is_active as artist_active, a.timezone, c.archived_at as client_archived_at,
         bs.appointment_created_from
    into v_session
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  join public.clients c on c.id = s.client_id
  left join crm_private.booking_card_artist_settings bs on bs.artist_id = s.artist_id
  where s.id = p_session_id;

  if not found then
    return query select false, 'session_not_found', null::text, null::numeric,
      null::numeric, null::numeric, null::text, null::text;
    return;
  end if;

  currency := v_session.currency;
  eligible := false;

  if not v_session.artist_active then
    reason := 'artist_inactive';
  elsif v_session.client_archived_at is not null then
    reason := 'client_archived';
  elsif v_session.status <> 'confirmed'::public.session_status then
    reason := 'not_confirmed';
  elsif v_session.start_at <= clock_timestamp() then
    reason := 'appointment_in_past';
  elsif v_session.appointment_created_from is not null
     and v_session.created_at < v_session.appointment_created_from then
    reason := 'appointment_before_activation';
  elsif nullif(btrim(coalesce(v_session.timezone, '')), '') is null then
    reason := 'artist_timezone_missing';
  elsif v_session.appointment_type in ('in_person_consultation'::public.appointment_type, 'video_consultation'::public.appointment_type) then
    eligible := true;
    reason := 'ready';
    card_kind := 'consultation_booked';
  elsif v_session.appointment_type <> 'tattoo_session'::public.appointment_type then
    reason := 'appointment_type_without_card';
  elsif v_session.price is null or v_session.price <= 0 then
    reason := 'session_price_missing';
  else
    session_price := v_session.price;

    select d.amount, d.currency, d.source_kind
      into v_deposit, v_deposit_currency, v_deposit_source
    from crm_private.booking_card_deposit_for_session(p_session_id) d;

    if not found or v_deposit is null or v_deposit <= 0 then
      reason := 'deposit_not_paid_for_session';
    elsif v_deposit_currency is distinct from v_session.currency then
      reason := 'deposit_currency_mismatch';
    elsif v_deposit > v_session.price then
      reason := 'deposit_exceeds_price';
      deposit_paid := v_deposit;
    else
      eligible := true;
      reason := 'ready';
      card_kind := 'tattoo_deposit_paid';
      deposit_paid := v_deposit;
      remaining_balance := v_session.price - v_deposit;
      deposit_source := v_deposit_source;
    end if;
  end if;

  return next;
end;
$function$;

-- Change only the consultation transport branch; tattoo cards remain identical.
do $video_wa$
declare v_sql text := pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure);
begin
  if position('    v_template_name := v_settings.whatsapp_consultation_template_name;
    v_parameters := jsonb_build_array(' in v_sql)=0 or position('    v_body := ''Your consultation is booked.'';' in v_sql)=0 then
    raise exception 'Unexpected booking-card WhatsApp function definition';
  end if;
  v_sql:=replace(v_sql,'    v_template_name := v_settings.whatsapp_consultation_template_name;
    v_parameters := jsonb_build_array(','    v_template_name := case when v_card.appointment_type = ''video_consultation''::public.appointment_type
      then v_settings.whatsapp_video_template_name
      else v_settings.whatsapp_consultation_template_name end;
    if v_card.appointment_type = ''video_consultation''::public.appointment_type
       and v_settings.whatsapp_video_template_status is distinct from ''APPROVED'' then
      return null;
    end if;
    v_parameters := jsonb_build_array(');
  v_sql:=replace(v_sql,'    v_body := ''Your consultation is booked.'';','    v_body := case when v_card.appointment_type = ''video_consultation''::public.appointment_type then ''Your video consultation is booked.'' else ''Your consultation is booked.'' end;');
  execute v_sql;
end;
$video_wa$;

-- Personal online consultations must not show the physical studio address or arrival wording.
do $video_email$
declare v_sql text := pg_get_functiondef('crm_private.render_booking_card_email(uuid,text,text)'::regprocedure);
begin
  if position('  v_grouped boolean := false;' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'  v_grouped boolean := false;','  v_grouped boolean := false;
  v_video boolean := false;');
  if position('  v_first_name := split_part(btrim(v_client_name), '' '', 1);' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'  v_first_name := split_part(btrim(v_client_name), '' '', 1);','  v_video := v_card.appointment_type = ''video_consultation''::public.appointment_type;
  v_first_name := split_part(btrim(v_client_name), '' '', 1);');
  if position('    v_title := ''Your consultation is booked'';
    subject := ''Your consultation is booked with '' || v_artist_name;' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'    v_title := ''Your consultation is booked'';
    subject := ''Your consultation is booked with '' || v_artist_name;','    v_title := case when v_video then ''Your video consultation is booked'' else ''Your consultation is booked'' end;
    subject := v_title || '' with '' || v_artist_name;');
  if position('    || v_settings.studio_name || E''\n''
    || v_settings.studio_address || E''\n''
    || v_settings.studio_map_url || E''\n\n''' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'    || v_settings.studio_name || E''\n''
    || v_settings.studio_address || E''\n''
    || v_settings.studio_map_url || E''\n\n''','    || case when v_video then E''Video consultation. We will agree how to connect before the call.\n\n''
       else v_settings.studio_name || E''\n'' || v_settings.studio_address || E''\n''
         || v_settings.studio_map_url || E''\n\n'' end');
  if position('|| case when v_grouped then E''Please confirm all sessions.\n\n'' else E''Please confirm so I know to expect you.\n\n'' end' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'|| case when v_grouped then E''Please confirm all sessions.\n\n'' else E''Please confirm so I know to expect you.\n\n'' end','|| case when v_video then E''Please confirm you can join the video call.\n\n'' when v_grouped then E''Please confirm all sessions.\n\n'' else E''Please confirm so I know to expect you.\n\n'' end');
  if position('|| case when v_grouped then E''Confirm all sessions:\n'' else E''I\''ll be there:\n'' end' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'|| case when v_grouped then E''Confirm all sessions:\n'' else E''I\''ll be there:\n'' end','|| case when v_video then E''Confirm video call:\n'' when v_grouped then E''Confirm all sessions:\n'' else E''I\''ll be there:\n'' end');
  if position('|| case when v_grouped then ''Please confirm all sessions.'' else ''Please confirm so I know to expect you.'' end' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'|| case when v_grouped then ''Please confirm all sessions.'' else ''Please confirm so I know to expect you.'' end','|| case when v_video then ''Please confirm you can join the video call.'' when v_grouped then ''Please confirm all sessions.'' else ''Please confirm so I know to expect you.'' end');
  if position('|| case when v_grouped then ''Confirm all sessions'' else ''I&#39;ll be there'' end' in v_sql)=0 then raise exception 'Unexpected booking-card email renderer'; end if;
  v_sql:=replace(v_sql,'|| case when v_grouped then ''Confirm all sessions'' else ''I&#39;ll be there'' end','|| case when v_video then ''Confirm video call'' when v_grouped then ''Confirm all sessions'' else ''I&#39;ll be there'' end');
  execute v_sql;
end;
$video_email$;
