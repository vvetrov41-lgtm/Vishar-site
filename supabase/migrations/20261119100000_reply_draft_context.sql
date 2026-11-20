-- Read-only, operator-scoped context for a "Suggest reply" draft in one client
-- conversation. It returns the conversation's newest text messages and up to
-- 80 past (client message, artist reply) pairs from the same artist's other
-- client conversations, so a model can write in that artist's own voice.
--
-- Nothing here sends, queues or stores a message. Personal conversations
-- (not_crm_at while no client or enquiry is linked, as in
-- crm_private.conversation_hidden_as_not_crm) are never a draft target and
-- never an example. Contact details
-- are masked before any text leaves the database.

create function crm_private.mask_reply_draft_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(p_text, ''),
          '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[email]', 'g'),
        '(https?://|www\.)[^[:space:]]+', '[link]', 'gi'),
      -- Sort codes: 12-34-56 anywhere, or any spacing right after "sort code".
      -- A bare "14 15 16" stays readable: it is more often dates than a bank.
      '(sort[ -]?code[^0-9]{0,4})[0-9]{2}[ -]?[0-9]{2}[ -]?[0-9]{2}|\m[0-9]{2}-[0-9]{2}-[0-9]{2}\M',
      '\1[number]', 'gi'),
    -- Phone and account numbers: at least seven digits, with at most two
    -- separators between neighbouring digits, so "14 - 15 November" survives.
    '\+?\(?[0-9](?:[ ()-]{0,2}[0-9]){6,}', '[number]', 'g');
$function$;

revoke all on function crm_private.mask_reply_draft_text(text)
  from public, anon, authenticated, service_role;

create function public.get_reply_draft_context(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_artist_id uuid;
  v_client_id uuid;
  v_channel text;
  v_last_inbound_at timestamptz;
  v_artist_name text;
  v_client_name text;
  v_rates jsonb;
  v_studio jsonb;
  v_messages jsonb := '[]'::jsonb;
  v_examples jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_conversation_id is null then
    raise exception 'conversation required' using errcode = '22023';
  end if;

  select c.artist_id, c.client_id, c.channel::text, c.last_inbound_at
    into v_artist_id, v_client_id, v_channel, v_last_inbound_at
    from public.communication_conversations c
    where c.id = p_conversation_id
      and c.state::text = 'open'
      and (c.not_crm_at is null or c.client_id is not null or c.enquiry_id is not null)
      and c.channel::text in ('whatsapp', 'instagram');
  if v_artist_id is null then
    raise exception 'conversation unavailable for a reply draft' using errcode = '42501';
  end if;
  perform crm_private.require_artist_access(v_artist_id, 'manage');

  select a.display_name into v_artist_name
    from public.artists a where a.id = v_artist_id and a.is_active = true;
  if not found then
    raise exception 'artist unavailable' using errcode = '42501';
  end if;

  if v_client_id is not null then
    select nullif(split_part(btrim(coalesce(cl.full_name, '')), ' ', 1), '') into v_client_name
      from public.clients cl where cl.id = v_client_id;
  end if;

  -- Standard rates only. Deposits, estimates and payment details are never
  -- part of a draft, so they are not returned.
  select jsonb_build_object(
    'currency', p.currency,
    'hourly_rate', p.hourly_rate,
    'full_day_rate', p.full_day_rate,
    'full_day_hours', p.full_day_hours
  ) into v_rates
    from crm_private.artist_session_pricing p where p.artist_id = v_artist_id;

  select jsonb_build_object(
    'name', nullif(btrim(coalesce(s.studio_name, '')), ''),
    'address', nullif(btrim(coalesce(s.studio_address, '')), '')
  ) into v_studio
    from crm_private.booking_card_artist_settings s where s.artist_id = v_artist_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'direction', x.direction, 'text', x.text, 'at', x.created_at) order by x.created_at asc), '[]'::jsonb)
    into v_messages
    from (
      select m.direction::text as direction,
        left(crm_private.mask_reply_draft_text(m.body), 600) as text,
        coalesce(m.provider_timestamp, m.sent_at, m.created_at) as created_at
      from public.communication_messages m
      where m.conversation_id = p_conversation_id
        and m.message_type = 'text'
        and nullif(btrim(coalesce(m.body, '')), '') is not null
        and m.status::text in ('received', 'sent', 'delivered', 'read')
      order by coalesce(m.provider_timestamp, m.sent_at, m.created_at) desc
      limit 20
    ) x;

  -- A pair is a client text answered by the artist's very next text in the
  -- same conversation, written by a person (provider app or CRM), within three
  -- days. A reply the artist sent word for word three or more times is a canned
  -- message, not a voice example.
  -- Conversation order is the provider's time, not ingestion time: a late
  -- webhook must not pair a reply with the wrong client message.
  with texts as (
    select m.conversation_id, m.direction::text as direction, m.origin::text as origin,
      m.body, coalesce(m.provider_timestamp, m.sent_at, m.created_at) as created_at,
      lag(m.direction::text) over w as prev_direction,
      lag(m.body) over w as prev_body,
      lag(coalesce(m.provider_timestamp, m.sent_at, m.created_at)) over w as prev_at
    from public.communication_messages m
    join public.communication_conversations c on c.id = m.conversation_id
    where m.artist_id = v_artist_id
      and c.artist_id = v_artist_id
      and (c.not_crm_at is null or c.client_id is not null or c.enquiry_id is not null)
      and c.id <> p_conversation_id
      and m.message_type = 'text'
      and nullif(btrim(coalesce(m.body, '')), '') is not null
      and m.status::text in ('received', 'sent', 'delivered', 'read')
      and (m.direction::text = 'inbound' or m.origin::text in ('provider_app', 'crm'))
    window w as (partition by m.conversation_id
      order by coalesce(m.provider_timestamp, m.sent_at, m.created_at), m.created_at, m.id)
  ), canned as (
    select t.body from texts t
    where t.direction = 'outbound'
    group by t.body having count(*) >= 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'channel', y.channel, 'client', y.client, 'reply', y.reply) order by y.created_at desc), '[]'::jsonb)
    into v_examples
    from (
      select c.channel::text as channel,
        left(crm_private.mask_reply_draft_text(t.prev_body), 240) as client,
        left(crm_private.mask_reply_draft_text(t.body), 400) as reply,
        t.created_at
      from texts t
      join public.communication_conversations c on c.id = t.conversation_id
      where t.direction = 'outbound'
        and t.prev_direction = 'inbound'
        and t.created_at - t.prev_at <= interval '3 days'
        and length(btrim(t.prev_body)) >= 10
        and not exists (select 1 from canned k where k.body = t.body)
      order by t.created_at desc
      limit 80
    ) y;

  return jsonb_build_object(
    'channel', v_channel,
    'artist', v_artist_name,
    'client_first_name', v_client_name,
    'rates', v_rates,
    'studio', v_studio,
    'whatsapp_window_open', case when v_channel = 'whatsapp'
      then v_last_inbound_at is not null and v_last_inbound_at > clock_timestamp() - interval '24 hours'
      else null end,
    'messages', v_messages,
    'examples', v_examples
  );
end;
$function$;

revoke all on function public.get_reply_draft_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_reply_draft_context(uuid) to authenticated;
comment on function public.get_reply_draft_context(uuid) is
  'Read-only operator-scoped context for an advisory reply draft; masks contact details, excludes personal conversations, never sends or stores a draft.';
