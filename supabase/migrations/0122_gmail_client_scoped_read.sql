-- 0122_gmail_client_scoped_read.sql
--
-- A client-scoped Gmail target, so mailbox history can be read once per client
-- instead of once per enquiry.
--
-- WHY THIS EXISTS
--
-- The Gmail Worker finds a client's correspondence by searching the artist's
-- mailbox for the CLIENT'S EMAIL ADDRESS (`searchThreads`, keyed on
-- `client_email`). It does not, and cannot, search per enquiry: Gmail has no
-- idea what a Vishar enquiry is.
--
-- `service_resolve_gmail_target` nevertheless requires an enquiry, because the
-- read it serves also binds reply context. That is correct for a reply. It is
-- actively harmful as a way to *discover* correspondence, because asking for
-- the same client under several enquiries returns THE SAME Gmail threads each
-- time, and `service_upsert_gmail_thread_context` is unique on
-- `(artist_id, enquiry_id, provider_thread_id)` (0059) - so one real Gmail
-- conversation would become several thread contexts bound to different
-- enquiries. A later GPT reply could then be routed through whichever binding
-- it happened to find.
--
-- So discovery gets its own resolution, with no enquiry in it at all, and the
-- Worker route that uses it creates no thread context. Nothing to bind means
-- nothing to bind wrongly.
--
-- WHAT IS DELIBERATELY UNCHANGED
--
-- Artist isolation. 0059 notes that clients are canonical people and are not
-- artist-owned rows, so the artist scope comes from the enquiry -> artist
-- binding. That still holds here: this function refuses unless the client
-- actually has an enquiry with the artist. It stops short of naming WHICH
-- enquiry, which is the whole point - the binding proves the relationship, it
-- does not select a thread context.
--
-- Backend-only, exactly like every other `service_` function in 0059. The
-- browser cannot call it, and the Worker reaches it only with the service
-- credential it already holds.
--
-- Forward-only. Adds one function; changes nothing that exists.

create or replace function public.service_resolve_gmail_client_target(
  p_artist_id uuid,
  p_client_id uuid
)
returns table(
  artist_id uuid,
  client_id uuid,
  client_email text,
  integration_key text,
  mailbox_email text,
  configuration jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_client_email text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail target resolution is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or p_client_id is null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  -- The artist -> client relationship must be one the CRM already records.
  -- Without this, knowing a client id would be enough to read any artist's
  -- mailbox for that address.
  select lower(btrim(c.email)) into v_client_email
  from public.clients c
  where c.id = p_client_id
    and exists (
      select 1
      from public.enquiries e
      where e.client_id = c.id
        and e.artist_id = p_artist_id
    );
  if not found or nullif(v_client_email, '') is null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  return query
  select p_artist_id, p_client_id, v_client_email,
         i.integration_key, lower(btrim(i.external_account_label)), i.configuration
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

revoke all on function public.service_resolve_gmail_client_target(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_resolve_gmail_client_target(uuid, uuid)
  to service_role;

comment on function public.service_resolve_gmail_client_target(uuid, uuid) is
  'Backend-only Gmail target for reading one client''s correspondence without naming an enquiry. Discovery only: the caller must not create thread contexts from it, because those are unique per enquiry and would duplicate a single Gmail thread across a client''s enquiries.';
