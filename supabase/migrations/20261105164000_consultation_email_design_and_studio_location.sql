-- Consultation emails: branded HTML reminders and correct map for in-person visits.
-- Preserve the original plain-text body and action tokens. No historical sends are replayed.
-- Other appointment types and global studio/WhatsApp location settings are unchanged.

create or replace function crm_private.consultation_email_location()
returns table(studio_name text, studio_address text, studio_map_url text)
language sql immutable
set search_path = pg_catalog
as $$
  select
    'Label Tattoo Kensington'::text,
    'Unit B, York House, Avonmore Place, London W14 8RL'::text,
    'https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic'::text;
$$;

create or replace function crm_private.render_consultation_reminder_html(
  p_session_id uuid,
  p_action_urls text[]
)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session record;
  v_location record;
  v_name text;
  v_when text;
  v_heading text;
  v_arrival text;
  v_location_html text := '';
  v_url text;
  v_html text;
begin
  if p_session_id is null or coalesce(cardinality(p_action_urls),0) <> 3
     or p_action_urls[1] = p_action_urls[2]
     or p_action_urls[1] = p_action_urls[3]
     or p_action_urls[2] = p_action_urls[3] then
    return null;
  end if;
  foreach v_url in array p_action_urls loop
    if v_url is null or v_url !~
      '^https://booking[.]vishartattoo[.]com/appointments/respond/[0-9a-f]{64}$' then
      return null;
    end if;
  end loop;

  select s.appointment_type, s.start_at, a.timezone,
         a.display_name as artist_name, c.full_name as client_name
    into v_session
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  join public.clients c on c.id = s.client_id
  where s.id = p_session_id and c.archived_at is null;

  if not found
     or v_session.appointment_type not in
       ('in_person_consultation'::public.appointment_type,
        'video_consultation'::public.appointment_type)
     or nullif(btrim(v_session.timezone),'') is null then
    return null;
  end if;

  v_name := split_part(btrim(coalesce(v_session.client_name,'')), ' ', 1);
  v_when := to_char(v_session.start_at at time zone v_session.timezone,
                    'FMDay, FMDD FMMonth YYYY') || ' at '
            || to_char(v_session.start_at at time zone v_session.timezone, 'HH24:MI');
  v_heading := case when v_session.appointment_type='video_consultation'::public.appointment_type
    then 'Your video consultation is tomorrow' else 'Your consultation is tomorrow' end;
  v_arrival := case when v_session.appointment_type='video_consultation'::public.appointment_type
    then 'Keep any reference images handy for our call.'
    else 'Bring any reference images or ideas you would like to discuss.' end;

  if v_session.appointment_type='in_person_consultation'::public.appointment_type then
    select * into v_location from crm_private.consultation_email_location();
    v_location_html :=
      '<tr><td style="padding:0 28px 22px;"><div style="background:#262629;border:1px solid #3c3c3f;border-radius:12px;padding:18px;">'
      || '<div style="font-size:11px;letter-spacing:1.6px;color:#b5b5b8;margin-bottom:9px;">LOCATION</div>'
      || '<div style="font-size:16px;font-weight:700;color:#f7f7f7;margin-bottom:6px;">'
      || crm_private.booking_card_html_escape(v_location.studio_name) || '</div>'
      || '<div style="font-size:14px;line-height:21px;color:#d2d2d4;">'
      || crm_private.booking_card_html_escape(v_location.studio_address) || '</div>'
      || '<div style="margin-top:12px;"><a href="'
      || crm_private.booking_card_html_escape(v_location.studio_map_url)
      || '" style="font-size:14px;font-weight:700;text-decoration:underline;color:#fff;">Get directions</a></div>'
      || '</div></td></tr>';
  end if;

  v_html :=
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">'
    || '<meta charset="utf-8"></head><body style="margin:0;padding:0;background:#111113;">'
    || '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
    || 'style="width:100%;background:#111113;font-family:Arial,Helvetica,sans-serif;">'
    || '<tr><td align="center" style="padding:24px 12px;">'
    || '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
    || 'style="width:100%;max-width:560px;background:#1b1b1d;border:1px solid #3c3c40;border-radius:16px;">'
    || '<tr><td style="padding:28px 28px 0;">'
    || '<div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#e8e8e8;">'
    || crm_private.booking_card_html_escape(v_session.artist_name) || ' / TATTOO</div>'
    || '<div style="height:1px;background:#444447;margin-top:20px;"></div></td></tr>'
    || '<tr><td style="padding:26px 28px 12px;">'
    || '<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#bebec2;">CONSULTATION REMINDER</div>'
    || '<h1 style="font-size:25px;line-height:31px;font-weight:700;letter-spacing:-.4px;color:#fff;margin:12px 0 18px;">'
    || crm_private.booking_card_html_escape(v_heading) || '</h1>'
    || '<p style="font-size:15px;line-height:23px;color:#dedee1;margin:0 0 10px;">Hi '
    || crm_private.booking_card_html_escape(v_name) || ',</p>'
    || '<p style="font-size:15px;line-height:23px;color:#dedee1;margin:0;">'
    || crm_private.booking_card_html_escape(v_arrival) || '</p></td></tr>'
    || '<tr><td style="padding:16px 28px 22px;">'
    || '<div style="background:#29292c;border-radius:12px;padding:18px;">'
    || '<div style="font-size:11px;letter-spacing:1.5px;color:#bdbdc0;margin-bottom:8px;">DATE &amp; TIME</div>'
    || '<div style="font-size:17px;line-height:25px;font-weight:700;color:#fff;">'
    || crm_private.booking_card_html_escape(v_when) || '</div>'
    || '<div style="font-size:13px;line-height:19px;color:#c1c1c5;margin-top:5px;">With '
    || crm_private.booking_card_html_escape(v_session.artist_name) || ' · London time</div>'
    || '</div></td></tr>'
    || v_location_html
    || '<tr><td style="padding:0 28px 8px;">'
    || '<a href="' || crm_private.booking_card_html_escape(p_action_urls[1])
    || '" style="display:block;padding:15px 12px;text-align:center;border-radius:9px;'
    || 'background:#f4f4f4;color:#121212;text-decoration:none;font-size:15px;font-weight:700;">'
    || 'Confirm attendance</a></td></tr>'
    || '<tr><td style="padding:0 28px 8px;">'
    || '<a href="' || crm_private.booking_card_html_escape(p_action_urls[2])
    || '" style="display:block;padding:14px 12px;text-align:center;border-radius:9px;'
    || 'border:1px solid #85858a;color:#f0f0f0;text-decoration:none;font-size:14px;font-weight:700;">'
    || 'Request a different time</a></td></tr>'
    || '<tr><td style="padding:0 28px 18px;">'
    || '<a href="' || crm_private.booking_card_html_escape(p_action_urls[3])
    || '" style="display:block;padding:13px 12px;text-align:center;border-radius:9px;'
    || 'color:#c8c8cd;text-decoration:underline;font-size:13px;">Cancel appointment</a></td></tr>'
    || '<tr><td style="padding:0 28px 25px;">'
    || '<p style="color:#b6b6bc;font-size:12px;line-height:18px;margin:0;">'
    || 'Your booking stays unchanged until you confirm an action on the next page. '
    || 'Need anything? Just reply to this email.</p></td></tr>'
    || '</table></td></tr></table></body></html>';
  return v_html;
end;
$$;

-- Change only new system-generated consultation reminders. HTML is an alternative
-- MIME part; original action links remain in text/plain and keep their token identity.
create or replace function crm_private.decorate_consultation_reminder_email()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session_id uuid;
  v_type public.appointment_type;
  v_location record;
  v_links text[];
begin
  if new.automation_job_id is null
     or new.created_by_kind is distinct from 'system'
     or new.template_key is distinct from 'consultation_reminder'
     or new.status is distinct from 'approved'::public.email_message_status
     or new.html_body is not null
     or new.booking_card_id is not null then
    return new;
  end if;

  select s.id,s.appointment_type into v_session_id,v_type
  from public.automation_jobs j
  join public.sessions s on s.id=j.session_id
  join public.clients c on c.id=s.client_id
  where j.id=new.automation_job_id
    and j.message_purpose='consultation_reminder'
    and j.artist_id=new.artist_id
    and s.artist_id=new.artist_id
    and s.client_id=new.client_id
    and lower(btrim(c.email))=lower(btrim(new.to_email))
    and s.appointment_type in
      ('in_person_consultation'::public.appointment_type,
       'video_consultation'::public.appointment_type);
  if not found then return new; end if;

  if v_type='in_person_consultation'::public.appointment_type then
    select * into v_location from crm_private.consultation_email_location();
    if position(v_location.studio_address in coalesce(new.body,''))=0 then
      new.body := rtrim(coalesce(new.body,'')) || E'\n\nStudio: '
        || v_location.studio_name || E'\n'
        || v_location.studio_address || E'\n'
        || v_location.studio_map_url;
    end if;
  end if;

  select array_agg(x.link[1]) into v_links
    from regexp_matches(
      coalesce(new.body,''),
      '(https://booking[.]vishartattoo[.]com/appointments/respond/[0-9a-f]{64})',
      'g'
    ) as x(link);
  new.html_body := crm_private.render_consultation_reminder_html(v_session_id,v_links);
  return new;
end;
$$;

drop trigger if exists email_messages_consultation_reminder_html on public.email_messages;
create trigger email_messages_consultation_reminder_html
before insert on public.email_messages
for each row execute function crm_private.decorate_consultation_reminder_email();

-- The existing booking-confirmation HTML already supports location data.
-- Override it only for an in-person consultation, not tattoo or video cards.
do $consultation_card_location$
declare
  v_sql text := pg_get_functiondef(
    'crm_private.render_booking_card_email(uuid,text,text)'::regprocedure
  );
  v_anchor text := '  v_first_name := split_part(btrim(v_client_name), '' '', 1);';
begin
  if position(v_anchor in v_sql)=0 then
    raise exception 'Unexpected booking-card email renderer: aborting location patch';
  end if;
  v_sql := replace(v_sql,v_anchor,
    '  if v_card.card_kind = ''consultation_booked'' and '
    || 'v_card.appointment_type = ''in_person_consultation''::public.appointment_type then'
    || E'\n'
    || '    select l.studio_name,l.studio_address,l.studio_map_url'
    || E'\n'
    || '      into v_settings.studio_name,v_settings.studio_address,v_settings.studio_map_url'
    || E'\n'
    || '    from crm_private.consultation_email_location() l;'
    || E'\n'
    || '  end if;'
    || E'\n'
    || v_anchor);
  execute v_sql;
end;
$consultation_card_location$;

revoke all on function crm_private.consultation_email_location()
  from public,anon,authenticated,service_role;
revoke all on function crm_private.render_consultation_reminder_html(uuid,text[])
  from public,anon,authenticated,service_role;
revoke all on function crm_private.decorate_consultation_reminder_email()
  from public,anon,authenticated,service_role;
