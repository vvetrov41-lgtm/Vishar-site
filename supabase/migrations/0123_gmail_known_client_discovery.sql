-- 0123_gmail_known_client_discovery.sql
--
-- Server-side resolution for discovering a KNOWN client's inbound Gmail.
--
-- WHY THIS EXISTS
--
-- The Inbox could only show email the CRM had already written. A client the
-- studio knows could email in for the first time and appear nowhere: no
-- `email_messages` row means no thread, and no thread means no row in the work
-- queue. The operator's own mailbox knew; the CRM did not.
--
-- Discovery needs two things the existing Gmail functions cannot give it,
-- because both are anchored to a client or an enquiry that discovery has not
-- identified yet:
--
--   1. the artist's mailbox, with no client in hand;
--   2. an answer to "which of these addresses belong to clients this artist
--      actually knows?".
--
-- WHY THE MATCHING LIVES HERE
--
-- (2) is the whole safety boundary of the feature, so it is a database read
-- rather than a judgement made in the Worker or the browser. The Worker hands
-- over addresses it saw in the mailbox and gets back only the ones the CRM can
-- name. Anything unmatched simply does not come back, so an unknown sender
-- cannot reach an operator surface by accident: there is no row to filter out
-- later, and no code path where forgetting a filter would leak one.
--
-- It also creates nothing. No client, no enquiry, no thread context. It is a
-- SELECT, and it is `stable`, so it cannot be anything else.
--
-- Artist isolation is the same proof 0059 and 0122 rely on: the client must
-- have an enquiry with this artist. Knowing an address is not enough to read
-- another artist's mailbox for it.
--
-- Deliberately NOT here: anything keyed by enquiry. Discovery answers "who is
-- this", once per client. Thread contexts are unique per
-- (artist, enquiry, provider thread), so creating one from discovery would
-- either invent an enquiry or bind the same conversation several times.
--
-- Forward-only. Adds two functions; changes nothing that exists.

-- ---------------------------------------------------------------------------
-- 1. The artist's mailbox, without naming a client
-- ---------------------------------------------------------------------------

create or replace function public.service_resolve_gmail_mailbox(
  p_artist_id uuid
)
returns table(
  artist_id uuid,
  integration_key text,
  mailbox_email text,
  configuration jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail target resolution is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  return query
  select p_artist_id, i.integration_key, lower(btrim(i.external_account_label)), i.configuration
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
  where i.artist_id = p_artist_id
    and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google'
    and i.is_enabled
    and nullif(btrim(i.external_account_label), '') is not null;

  if not found then
    raise exception 'artist Gmail integration is unavailable' using errcode = '22023';
  end if;
end;
$function$;

revoke all on function public.service_resolve_gmail_mailbox(uuid)
  from public, anon, authenticated;
grant execute on function public.service_resolve_gmail_mailbox(uuid)
  to service_role;

comment on function public.service_resolve_gmail_mailbox(uuid) is
  'Backend-only Gmail mailbox for one artist, for discovery reads that have not yet identified a client. Grants no access to message content by itself.';

-- ---------------------------------------------------------------------------
-- 2. Which addresses belong to clients this artist knows
-- ---------------------------------------------------------------------------

create or replace function public.service_match_gmail_clients(
  p_artist_id uuid,
  p_emails text[]
)
returns table(
  client_id uuid,
  client_email text,
  full_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_emails text[];
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail client matching is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  -- Normalised the same way `clients.email` is compared everywhere else, and
  -- bounded so one mailbox page cannot turn into an unbounded lookup.
  select array_agg(distinct lower(btrim(e)))
    into v_emails
  from unnest(coalesce(p_emails, array[]::text[])) as e
  where nullif(btrim(e), '') is not null;

  if v_emails is null or cardinality(v_emails) = 0 then
    return;
  end if;
  if cardinality(v_emails) > 200 then
    raise exception 'too many Gmail addresses to match at once' using errcode = '22023';
  end if;

  -- One row per client, never one per enquiry: a client with three enquiries is
  -- still one person with one mailbox, and returning them three times is how a
  -- single conversation becomes three rows in the operator's queue.
  return query
  select distinct on (c.id)
         c.id, lower(btrim(c.email)), c.full_name
  from public.clients c
  where lower(btrim(c.email)) = any(v_emails)
    and c.archived_at is null
    and exists (
      select 1
      from public.enquiries e
      where e.client_id = c.id
        and e.artist_id = p_artist_id
    )
  order by c.id;
end;
$function$;

revoke all on function public.service_match_gmail_clients(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.service_match_gmail_clients(uuid, text[])
  to service_role;

comment on function public.service_match_gmail_clients(uuid, text[]) is
  'Backend-only address-to-client resolution for Gmail discovery. Returns only clients this artist already knows, at most one row per client, and creates nothing: an address it cannot name simply does not come back.';
