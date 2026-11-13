-- 2026-11-13. Conservative local response evidence while Workers AI is rate-limited.
-- RLS excludes archived clients from the Gmail metadata *inbox* without deleting
-- their historical emails, finance, snapshots or client records.

alter policy gmail_client_metadata_snapshots_select
  on public.gmail_client_metadata_snapshots
  using (
    public.can_access_artist(artist_id)
    and public.can_access_client(client_id)
    and exists (
      select 1 from public.clients c
      where c.id = client_id and c.archived_at is null
    )
  );

-- A tiny acknowledgement following a studio answer is an observed closure,
-- not a request for AI. Do not mistake a first contact for an acknowledgement.
create or replace function crm_private.is_short_reply_acknowledgement(p_body text)
returns boolean
language sql immutable parallel safe
set search_path = pg_catalog
as $fn$
  select coalesce(
    p_body is not null
    and length(btrim(p_body)) between 1 and 80
    and p_body !~ '[?¿؟]'
    and btrim(regexp_replace(
      lower(p_body), '[[:space:].!,👌🏼👍🏻👍🏼👍🏽👍🏿🤝🙏😊🙂☺️]+', '', 'g'
    )) = any(array['cool','ok','okay','great','perfect','soundsgood','gotit','niceone','brilliant']),
    false
  );
$fn$;

revoke all on function crm_private.is_short_reply_acknowledgement(text)
  from public, anon, authenticated, service_role;

-- Only an *explicit manually sent* provider-app reaction may close an
-- informational answer. Requests, questions, appointment changes and payment
-- topics remain due. The existing authoritative reply_required mark always
-- wins; automation-origin reactions never count.
create or replace function crm_private.studio_reaction_acknowledged_at(p_inbound_id uuid)
returns timestamptz
language sql stable security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  select min(coalesce(r.sent_at, r.provider_timestamp, r.created_at))
  from public.communication_messages i
  join public.communication_conversations c
    on c.id = i.conversation_id and c.artist_id = i.artist_id
  join public.communication_messages r
    on r.conversation_id = i.conversation_id and r.artist_id = i.artist_id
  where i.id = p_inbound_id
    and i.direction = 'inbound'
    and r.direction = 'outbound'
    and r.message_type = 'reaction'
    and r.origin in ('crm', 'provider_app')
    and r.status in ('sent', 'delivered', 'read')
    and coalesce(r.sent_at, r.provider_timestamp, r.created_at) >
        coalesce(i.provider_timestamp, i.created_at)
    and (
      crm_private.is_closing_message(i.body)
      or exists (
        select 1 from crm_private.client_reply_marks m
        where c.client_id is not null
          and m.artist_id = c.artist_id and m.client_id = c.client_id
          and m.message_at = coalesce(i.provider_timestamp, i.created_at)
          and m.reply_state = 'no_reply_needed'
      )
      or (
        r.origin = 'provider_app'
        and i.message_type = 'text'
        -- A reaction is a local acknowledgement only in an ongoing exchange.
        -- First-contact reactions and long-running booking choices still wait.
        and exists (
          select 1 from public.communication_messages prev
          where prev.conversation_id = i.conversation_id
            and prev.artist_id = i.artist_id
            and prev.direction = 'outbound'
            and prev.origin in ('crm', 'provider_app')
            and prev.status in ('sent', 'delivered', 'read')
            and prev.message_type = 'text'
            and coalesce(prev.sent_at, prev.provider_timestamp, prev.created_at)
                  between coalesce(i.provider_timestamp, i.created_at) - interval '24 hours'
                      and coalesce(i.provider_timestamp, i.created_at)
        )
        and length(btrim(coalesce(i.body, ''))) between 1 and 160
        and i.body !~ '[?¿؟]'
        and lower(i.body) !~ '\m(can|could|would|will|do|does|did|is|are|when|where|why|how|what|who|which|please|help|need|let|confirm|cancel|change|move|reschedule|book|booking|appointment|session|deposit|pay|paid|payment|refund|price|cost|quote|address|location|date|time|instead|urgent)\M'
      )
    )
    and not exists (
      select 1 from crm_private.client_reply_marks m
      where c.client_id is not null
        and m.artist_id = c.artist_id and m.client_id = c.client_id
        and m.message_at = coalesce(i.provider_timestamp, i.created_at)
        and m.reply_state = 'reply_required'
    );
$fn$;

revoke all on function crm_private.studio_reaction_acknowledged_at(uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.conversation_awaiting_reply_since(p_conversation_id uuid)
returns timestamptz
language sql stable security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  with latest as (
    select m.id as inbound_id, m.body as inbound_body,
           coalesce(m.provider_timestamp, m.created_at) as inbound_at
    from public.communication_messages m
    where m.conversation_id = p_conversation_id
      and m.direction = 'inbound'
      and crm_private.communication_event_is_actionable(m.message_type)
    order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
    limit 1
  )
  select case
    when x.inbound_at is not null
      and x.inbound_at > coalesce(s.studio_at, '-infinity'::timestamptz)
      and crm_private.inbound_message_handled_by_booking(x.inbound_id) is null
      and crm_private.studio_reaction_acknowledged_at(x.inbound_id) is null
      and not (
        s.studio_at is not null
        and x.inbound_at <= s.studio_at + interval '24 hours'
        and crm_private.is_short_reply_acknowledgement(x.inbound_body)
        and not exists (
          select 1
          from public.communication_conversations c
          join crm_private.client_reply_marks m
            on m.artist_id = c.artist_id and m.client_id = c.client_id
          where c.id = p_conversation_id
            and c.client_id is not null
            and m.message_at = x.inbound_at
            and m.reply_state = 'reply_required'
        )
      )
    then x.inbound_at
  end
  from latest x
  cross join lateral (
    select crm_private.conversation_last_studio_reply_at(p_conversation_id) as studio_at
  ) s;
$fn$;

revoke all on function crm_private.conversation_awaiting_reply_since(uuid)
  from public, anon, authenticated, service_role;
