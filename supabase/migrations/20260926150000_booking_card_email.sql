-- 20260926150000_booking_card_email.sql
--
-- Reviewed Email booking-card renderer and system provenance. This still does
-- not enqueue delivery; shared Email+WhatsApp dispatch is activated only after
-- both channel transports exist.

alter table public.email_messages
  add column if not exists booking_card_id uuid
    references crm_private.booking_cards(id) on delete restrict;

create unique index if not exists email_messages_booking_card_unique
  on public.email_messages(booking_card_id)
  where booking_card_id is not null;

alter table public.email_messages
  drop constraint if exists email_messages_approval_required;

alter table public.email_messages
  add constraint email_messages_approval_required
  check (
    status not in ('approved', 'queued', 'sent')
    or (
      approved_at is not null
      and (
        (
          created_by_kind = 'system'
          and approved_by is null
          and created_by is null
          and (
            ((automation_job_id is not null)::int)
            + ((payment_request_id is not null)::int)
            + ((booking_card_id is not null)::int)
          ) = 1
        )
        or
        (
          created_by_kind in ('human', 'ai')
          and approved_by is not null
          and automation_job_id is null
          and payment_request_id is null
          and booking_card_id is null
        )
      )
    )
  );

comment on column public.email_messages.booking_card_id is
  'Canonical booking-card snapshot that authorized this reviewed system email.';

create or replace function crm_private.guard_booking_card_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_expected_template text;
begin
  if new.booking_card_id is null then
    return new;
  end if;

  if new.created_by_kind <> 'system'
     or new.created_by is not null
     or new.approved_by is not null
     or new.automation_job_id is not null
     or new.payment_request_id is not null then
    raise exception 'booking card email provenance must be system-only'
      using errcode = '23514';
  end if;

  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = new.booking_card_id;

  if not found then
    raise exception 'booking card email has no canonical card'
      using errcode = '23503';
  end if;

  v_expected_template := case v_card.card_kind
    when 'tattoo_deposit_paid' then 'booking_card_tattoo'
    when 'consultation_booked' then 'booking_card_consultation'
    else null
  end;

  if v_expected_template is null
     or new.template_key is distinct from v_expected_template
     or new.artist_id is distinct from v_card.artist_id
     or new.client_id is distinct from v_card.client_id
     or new.enquiry_id is distinct from v_card.enquiry_id
     or new.project_id is distinct from v_card.project_id
     or new.gmail_thread_context_id is not null then
    raise exception 'booking card email links do not match canonical facts'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if v_card.superseded_at is not null
       or not exists (
         select 1
         from public.sessions s
         where s.id = v_card.session_id
           and s.artist_id = v_card.artist_id
           and s.client_id = v_card.client_id
           and s.status = 'confirmed'::public.session_status
           and s.calendar_version = v_card.calendar_version
           and s.start_at > now()
       ) then
      raise exception 'booking card email is obsolete'
        using errcode = '23514';
    end if;
  else
    if new.booking_card_id is distinct from old.booking_card_id
       or new.artist_id is distinct from old.artist_id
       or new.client_id is distinct from old.client_id
       or new.enquiry_id is distinct from old.enquiry_id
       or new.project_id is distinct from old.project_id
       or new.to_email is distinct from old.to_email
       or new.subject is distinct from old.subject
       or new.body is distinct from old.body
       or new.html_body is distinct from old.html_body
       or new.template_key is distinct from old.template_key
       or new.template_version is distinct from old.template_version
       or new.created_by_kind is distinct from old.created_by_kind
       or new.created_by is distinct from old.created_by
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at then
      raise exception 'booking card email content and provenance are immutable'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists email_messages_booking_card_guard
  on public.email_messages;
create trigger email_messages_booking_card_guard
before insert or update on public.email_messages
for each row execute function crm_private.guard_booking_card_email();

create or replace function crm_private.booking_card_html_escape(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select replace(
    replace(
      replace(
        replace(
          replace(coalesce(p_value, ''), '&', '&amp;'),
          '<', '&lt;'
        ),
        '>', '&gt;'
      ),
      '"', '&quot;'
    ),
    '''', '&#39;'
  );
$$;

create or replace function crm_private.booking_card_money(
  p_amount numeric,
  p_currency text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_amount is null then null
    when upper(p_currency) = 'GBP'
      then '£' || regexp_replace(to_char(p_amount, 'FM999999990.00'), '\.00$', '')
    else regexp_replace(to_char(p_amount, 'FM999999990.00'), '\.00$', '')
      || ' ' || upper(p_currency)
  end;
$$;

create or replace function crm_private.render_booking_card_email(
  p_booking_card_id uuid,
  p_confirm_token text,
  p_reschedule_token text
)
returns table (
  subject text,
  body text,
  html_body text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client_name text;
  v_artist_name text;
  v_first_name text;
  v_date text;
  v_time text;
  v_confirm_url text;
  v_reschedule_url text;
  v_deposit text;
  v_remaining text;
  v_title text;
  v_finance_text text := '';
  v_finance_html text := '';
begin
  if p_booking_card_id is null
     or coalesce(p_confirm_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_reschedule_token, '') !~ '^[0-9a-f]{64}$'
     or p_confirm_token = p_reschedule_token then
    return;
  end if;

  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id
    and s.email_enabled;

  if not found then
    return;
  end if;

  select c.full_name, a.display_name
    into v_client_name, v_artist_name
  from public.clients c
  join public.artists a on a.id = v_card.artist_id
  where c.id = v_card.client_id
    and c.archived_at is null;

  if not found
     or nullif(btrim(v_client_name), '') is null
     or nullif(btrim(v_artist_name), '') is null then
    return;
  end if;

  v_first_name := split_part(btrim(v_client_name), ' ', 1);
  v_date := to_char(v_card.start_at at time zone v_card.timezone, 'FMDay, FMDD FMMonth YYYY');
  v_time := to_char(v_card.start_at at time zone v_card.timezone, 'HH24:MI');
  if v_settings.client_action_base_url is null then
    return;
  end if;
  v_confirm_url := v_settings.client_action_base_url || p_confirm_token;
  v_reschedule_url := v_settings.client_action_base_url || p_reschedule_token;

  if v_card.card_kind = 'tattoo_deposit_paid' then
    v_title := 'Your tattoo session is booked';
    subject := 'Your tattoo session is booked with ' || v_artist_name;
    v_deposit := crm_private.booking_card_money(v_card.deposit_paid, v_card.currency);
    v_remaining := crm_private.booking_card_money(v_card.remaining_balance, v_card.currency);
    v_finance_text := E'\nDeposit paid: ' || v_deposit
      || E'\nRemaining balance: ' || v_remaining;
    v_finance_html :=
      '<div style="margin:20px 0;padding:16px;border-radius:12px;background:#f6f6f6;">'
      || '<div style="margin-bottom:8px;"><strong>Deposit paid:</strong> '
      || crm_private.booking_card_html_escape(v_deposit) || '</div>'
      || '<div><strong>Remaining balance:</strong> '
      || crm_private.booking_card_html_escape(v_remaining) || '</div>'
      || '</div>';
  elsif v_card.card_kind = 'consultation_booked' then
    v_title := 'Your consultation is booked';
    subject := 'Your consultation is booked with ' || v_artist_name;
  else
    return;
  end if;

  body :=
    'Hi ' || v_first_name || E',\n\n'
    || v_title || E'.\n\n'
    || 'Artist: ' || v_artist_name || E'\n'
    || 'When: ' || v_date || ' at ' || v_time
    || v_finance_text || E'\n\n'
    || v_settings.studio_name || E'\n'
    || v_settings.studio_address || E'\n'
    || v_settings.studio_map_url || E'\n\n'
    || E'Please confirm so I know to expect you.\n\n'
    || E'I\'ll be there:\n' || v_confirm_url || E'\n\n'
    || E'Need another time:\n' || v_reschedule_url;

  html_body :=
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f2;'
    || 'font-family:Arial,Helvetica,sans-serif;color:#111;">'
    || '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:18px;'
    || 'padding:28px;box-sizing:border-box;">'
    || '<p style="margin:0 0 20px;">Hi '
    || crm_private.booking_card_html_escape(v_first_name) || ',</p>'
    || '<h1 style="font-size:24px;line-height:1.2;margin:0 0 22px;">'
    || crm_private.booking_card_html_escape(v_title) || ' ✓</h1>'
    || '<div style="line-height:1.6;">'
    || '<div><strong>Artist:</strong> '
    || crm_private.booking_card_html_escape(v_artist_name) || '</div>'
    || '<div><strong>When:</strong> '
    || crm_private.booking_card_html_escape(v_date || ' at ' || v_time) || '</div>'
    || '</div>'
    || v_finance_html
    || '<div style="margin:20px 0;line-height:1.5;">'
    || '<strong>' || crm_private.booking_card_html_escape(v_settings.studio_name) || '</strong><br>'
    || crm_private.booking_card_html_escape(v_settings.studio_address) || '<br>'
    || '<a href="' || crm_private.booking_card_html_escape(v_settings.studio_map_url)
    || '" style="color:#111;">View location</a></div>'
    || '<p style="margin:24px 0 14px;">Please confirm so I know to expect you.</p>'
    || '<a href="' || v_confirm_url
    || '" style="display:block;text-align:center;text-decoration:none;background:#111;color:#fff;'
    || 'padding:14px 18px;border-radius:10px;font-weight:700;margin-bottom:10px;">I&#39;ll be there</a>'
    || '<a href="' || v_reschedule_url
    || '" style="display:block;text-align:center;text-decoration:none;border:1px solid #bbb;color:#111;'
    || 'padding:13px 18px;border-radius:10px;font-weight:700;">Need another time</a>'
    || '</div></body></html>';

  return next;
end;
$$;

create or replace function crm_private.create_booking_card_email(
  p_booking_card_id uuid,
  p_confirm_token text,
  p_reschedule_token text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_client_email text;
  v_content record;
  v_email_id uuid;
  v_template_key text;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return null;
  end if;

  select lower(btrim(c.email))
    into v_client_email
  from public.clients c
  where c.id = v_card.client_id
    and c.archived_at is null;

  if nullif(v_client_email, '') is null
     or crm_private.client_send_block_reason(
       v_card.client_id,
       'email'::public.message_template_channel,
       'service'::public.message_classification
     ) is not null then
    return null;
  end if;

  select * into v_content
  from crm_private.render_booking_card_email(
    p_booking_card_id,
    p_confirm_token,
    p_reschedule_token
  );

  if not found
     or nullif(btrim(v_content.subject), '') is null
     or nullif(btrim(v_content.body), '') is null
     or nullif(btrim(v_content.html_body), '') is null then
    return null;
  end if;

  v_template_key := case v_card.card_kind
    when 'tattoo_deposit_paid' then 'booking_card_tattoo'
    when 'consultation_booked' then 'booking_card_consultation'
    else null
  end;

  if v_template_key is null then
    return null;
  end if;

  insert into public.email_messages (
    status,
    artist_id,
    client_id,
    enquiry_id,
    project_id,
    to_email,
    subject,
    body,
    html_body,
    template_key,
    template_version,
    created_by,
    created_by_kind,
    approved_by,
    approved_at,
    booking_card_id
  ) values (
    'approved',
    v_card.artist_id,
    v_card.client_id,
    v_card.enquiry_id,
    v_card.project_id,
    v_client_email,
    v_content.subject,
    v_content.body,
    v_content.html_body,
    v_template_key,
    1,
    null,
    'system',
    null,
    now(),
    v_card.id
  )
  on conflict (booking_card_id)
    where booking_card_id is not null
  do nothing
  returning id into v_email_id;

  if v_email_id is null then
    select m.id into v_email_id
    from public.email_messages m
    where m.booking_card_id = v_card.id;
  end if;

  return v_email_id;
end;
$$;

revoke all on function crm_private.guard_booking_card_email()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.booking_card_html_escape(text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.booking_card_money(numeric, text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.render_booking_card_email(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.create_booking_card_email(uuid, text, text)
  from public, anon, authenticated, service_role;
