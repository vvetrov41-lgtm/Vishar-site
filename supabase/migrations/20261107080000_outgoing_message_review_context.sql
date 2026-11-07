-- A read-only, operator-scoped snapshot for AI review before an outgoing
-- WhatsApp/Instagram reply or Gmail draft approval. No AI output is trusted to
-- choose an artist, recipient, record or action. This function never sends mail.
create function public.get_outgoing_message_review_context(
  p_conversation_id uuid default null,
  p_email_message_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_artist_id uuid;
  v_client_id uuid;
  v_enquiry_id uuid;
  v_artist_name text;
  v_timezone text;
  v_channel text;
  v_pricing jsonb;
  v_studio jsonb;
  v_sessions jsonb := '[]'::jsonb;
  v_projects jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
  v_messages jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if (p_conversation_id is null) = (p_email_message_id is null) then
    raise exception 'choose exactly one outgoing message target' using errcode = '22023';
  end if;
  if p_conversation_id is not null then
    select c.artist_id, c.client_id, c.enquiry_id, c.channel::text
      into v_artist_id, v_client_id, v_enquiry_id, v_channel
      from public.communication_conversations c
      where c.id = p_conversation_id and c.state::text = 'open';
  else
    select m.artist_id, m.client_id, m.enquiry_id, 'email'
      into v_artist_id, v_client_id, v_enquiry_id, v_channel
      from public.email_messages m
      where m.id = p_email_message_id and m.status::text = 'draft';
  end if;
  if v_artist_id is null then
    raise exception 'outgoing message target unavailable' using errcode = '42501';
  end if;
  perform crm_private.require_artist_access(v_artist_id, 'manage');
  select a.display_name, a.timezone into v_artist_name, v_timezone
    from public.artists a where a.id = v_artist_id and a.is_active = true;
  if not found then
    raise exception 'artist unavailable' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'currency', p.currency,
    'hourly_rate', p.hourly_rate,
    'full_day_rate', p.full_day_rate,
    'full_day_hours', p.full_day_hours,
    'standard_session_deposit', p.session_deposit_amount
  ) into v_pricing
    from crm_private.artist_session_pricing p where p.artist_id = v_artist_id;

  select jsonb_build_object(
    'name', nullif(btrim(coalesce(s.studio_name, '')), ''),
    'address', nullif(btrim(coalesce(s.studio_address, '')), ''),
    'map_url', nullif(btrim(coalesce(s.studio_map_url, '')), '')
  ) into v_studio
    from crm_private.booking_card_artist_settings s where s.artist_id = v_artist_id;

  if v_client_id is not null then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.start_at), '[]'::jsonb) into v_sessions
      from (
        select s.start_at, s.end_at, s.appointment_type::text as type,
          s.status::text as status, s.price, s.currency, s.duration_hours
        from public.sessions s
        where s.artist_id = v_artist_id and s.client_id = v_client_id
          and s.start_at > clock_timestamp() - interval '1 day'
          and s.cancelled_at is null
          and s.status::text in ('draft', 'proposed', 'confirmed')
        order by s.start_at asc limit 6
      ) x;

    select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb) into v_projects
      from (
        select p.title, p.status::text as status, p.hourly_rate,
          p.estimated_hours, p.estimated_sessions, p.estimate_total,
          p.deposit_amount, p.deposit_status::text as deposit_status,
          p.deposit_override_amount, p.currency, p.updated_at
        from public.projects p
        where p.artist_id = v_artist_id and p.client_id = v_client_id
          and p.archived_at is null
        order by p.updated_at desc limit 3
      ) x;

    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_payments
      from (
        select r.purpose::text as purpose, r.amount, r.currency,
          r.status::text as status, r.created_at
        from public.payment_requests r
        where r.artist_id = v_artist_id and r.client_id = v_client_id
        order by r.created_at desc limit 4
      ) x;
  end if;

  if p_conversation_id is not null then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at asc), '[]'::jsonb) into v_messages
      from (
        select m.direction::text as direction, left(m.body, 260) as text,
          m.created_at
        from public.communication_messages m
        where m.conversation_id = p_conversation_id
          and m.body is not null
          and m.status::text in ('received', 'sent', 'delivered', 'read')
        order by m.created_at desc limit 5
      ) x;
  elsif v_client_id is not null then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at asc), '[]'::jsonb) into v_messages
      from (
        select 'outbound'::text as direction,
          left(coalesce(m.subject, '') || ': ' || coalesce(m.body, ''), 260) as text,
          m.created_at
        from public.email_messages m
        where m.artist_id = v_artist_id and m.client_id = v_client_id
          and m.id is distinct from p_email_message_id
          and m.status::text = 'sent'
        order by m.created_at desc limit 5
      ) x;
  end if;

  return jsonb_build_object(
    'channel', v_channel,
    'artist', v_artist_name,
    'timezone', v_timezone,
    'client_linked', v_client_id is not null,
    'rates', v_pricing,
    'studio', v_studio,
    'upcoming_sessions', v_sessions,
    'projects', v_projects,
    'payment_requests', v_payments,
    'recent_messages', v_messages
  );
end;
$function$;

revoke all on function public.get_outgoing_message_review_context(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_outgoing_message_review_context(uuid,uuid)
  to authenticated;
comment on function public.get_outgoing_message_review_context(uuid,uuid) is
  'Read-only operator-scoped facts for an advisory outbound AI review; never sends or logs a draft.';
