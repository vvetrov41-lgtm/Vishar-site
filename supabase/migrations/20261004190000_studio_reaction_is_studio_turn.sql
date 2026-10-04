-- A reaction the studio sends after the client's newest real message is the
-- studio taking its turn.
--
-- 20261004180000 counted only actionable outbound types as a reply, so a
-- studio reaction left the conversation waiting. Production readback after
-- that release showed the cost: five unknown-sender conversations returned
-- to Today, and in every one the client's last message was a closing line
-- ("see you then", "all good", "I'll update you") that the artist
-- acknowledged with a reaction from the phone. Nothing was owed.
--
-- The reaction still has to come after the newest actionable inbound (the
-- max() comparison in conversation_awaiting_reply_since), so a new client
-- message after it waits again. An edit, a revoke or an unsupported echo is
-- still not a reply; inbound actionability is unchanged.

create or replace function crm_private.conversation_last_studio_reply_at(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select max(coalesce(m.sent_at, m.provider_timestamp, m.created_at))
  from public.communication_messages m
  where m.conversation_id = p_conversation_id
    and m.direction = 'outbound'
    and m.origin in ('crm', 'provider_app')
    and m.status in ('sent', 'delivered', 'read')
    and (crm_private.communication_event_is_actionable(m.message_type) or m.message_type = 'reaction');
$$;

revoke all on function crm_private.conversation_last_studio_reply_at(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.conversation_last_studio_reply_at(uuid) is
  'The studio''s newest provider-accepted turn from the CRM or the provider app: a message or a reaction. Edits, revokes, unsupported echoes, automations, queued and failed sends are not a turn.';
