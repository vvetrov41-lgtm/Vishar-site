-- 20260924060000_conversation_link_suggestion.sql
--
-- Phase 5 of the CRM AI architecture: triage for messages from people the CRM
-- cannot name yet.
--
-- Production baseline when this was written: 28 open conversations from
-- unknown senders were waiting on a reply, 20 of them for more than a day.
-- The product rule stays as it is (ConversationPage): an inbound message is
-- not an enquiry and nothing is linked or promoted automatically. What was
-- missing is the one fact the database can establish exactly: that this
-- sender's phone number or Instagram handle already belongs to one known
-- client of this artist.
--
-- WhatsApp conversations already link themselves on an exact unique phone
-- match when they are created or receive a message
-- (crm_private.auto_link_whatsapp_conversation_client). That leaves two gaps:
-- Instagram, which has no automatic link, and a WhatsApp sender whose number
-- was added to a client after their last message.
--
-- `get_conversation_link_suggestion` answers that for one conversation. It
-- suggests a client only for an EXACT and UNIQUE match inside the same scope
-- `link_communication_conversation_client` enforces, so accepting the
-- suggestion always succeeds and never crosses artists. Two matching clients
-- is an ambiguity, reported as such and never resolved by guessing. No model
-- is involved and nothing is written.

create function crm_private.conversation_link_candidates(p_conversation_id uuid)
returns table (client_id uuid, full_name text, match text)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with conv as (
    select c.id, c.artist_id, c.channel::text as channel, c.external_contact_id, c.external_username,
           a.workspace_id
    from public.communication_conversations c
    join public.artists a on a.id = c.artist_id
    where c.id = p_conversation_id and c.client_id is null
  )
  select distinct cl.id, left(cl.full_name, 80), m.match
  from conv
  join public.clients cl on cl.workspace_id = conv.workspace_id and cl.archived_at is null
  cross join lateral (
    -- The same normalisation the WhatsApp auto-link trigger uses (0915).
    select 'phone'::text as match
    where conv.channel = 'whatsapp'
      and crm_private.normalize_whatsapp_phone(cl.phone) is not null
      and crm_private.normalize_whatsapp_phone(cl.phone) = crm_private.normalize_whatsapp_phone(
            '+' || regexp_replace(coalesce(conv.external_contact_id, ''), '\D', '', 'g'))
    union all
    select 'instagram'
    where conv.channel = 'instagram'
      and conv.external_username is not null and btrim(conv.external_username) <> ''
      and lower(ltrim(btrim(cl.instagram), '@')) = lower(ltrim(btrim(conv.external_username), '@'))
  ) m
  where crm_private.client_in_artist_scope(cl.id, conv.artist_id);
$$;

revoke all on function crm_private.conversation_link_candidates(uuid)
  from public, anon, authenticated, service_role;

create function public.get_conversation_link_suggestion(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist uuid;
  v_client_id uuid;
  v_linked uuid;
  v_count integer;
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;

  select c.artist_id, c.client_id into v_artist, v_linked
  from public.communication_conversations c where c.id = p_conversation_id;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_artist, 'view_clients');

  if v_linked is not null then
    return jsonb_build_object('status', 'linked');
  end if;

  select count(distinct k.client_id) into v_count
  from crm_private.conversation_link_candidates(p_conversation_id) k;

  if v_count = 0 then
    return jsonb_build_object('status', 'none');
  elsif v_count > 1 then
    -- Two known clients share this number or handle. Choosing one would be a
    -- guess; the operator decides with the ordinary link search.
    return jsonb_build_object('status', 'ambiguous', 'count', v_count);
  end if;

  select k.client_id, k.full_name, min(k.match) as match into v_row
  from crm_private.conversation_link_candidates(p_conversation_id) k
  group by k.client_id, k.full_name;

  return jsonb_build_object(
    'status', 'suggested',
    'client_id', v_row.client_id,
    'client_name', v_row.full_name,
    'match', v_row.match
  );
end;
$$;

revoke all on function public.get_conversation_link_suggestion(uuid) from public, anon, service_role;
grant execute on function public.get_conversation_link_suggestion(uuid) to authenticated;

comment on function public.get_conversation_link_suggestion(uuid) is
  'Read-only. Suggests the one known client whose phone or Instagram handle exactly matches an unmatched conversation, within the scope linking enforces. Never links, never guesses between two.';
