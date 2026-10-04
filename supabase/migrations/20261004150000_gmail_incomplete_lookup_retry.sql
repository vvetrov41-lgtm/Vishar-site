-- 20261004150000_gmail_incomplete_lookup_retry.sql
--
-- A Gmail first-reply lookup that found SENT mail but did not read the whole
-- enquiry window (complete = false) was never repeated, so that enquiry kept
-- an unknown first reply time for good. On production four such rows were
-- written between the 20261004120000 database release and the Gmail Worker
-- redeploy, by the one-page Worker build through the three-argument record
-- function. They are now looked up again daily; nothing else changes.

create or replace function public.service_list_gmail_reply_candidates(
  p_artist_id uuid,
  p_limit integer default 3
)
returns table (
  enquiry_id uuid,
  client_email text,
  created_at timestamptz,
  closed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail reply candidates are backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or coalesce(p_limit, 0) < 1 or p_limit > 10 then
    raise exception 'invalid Gmail reply candidate request' using errcode = '22023';
  end if;

  return query
  select e.id, lower(btrim(c.email)), e.created_at, w.closed_at
  from public.enquiries e
  join public.clients c on c.id = e.client_id and c.archived_at is null
  cross join lateral crm_private.enquiry_reply_window(e.id) w
  left join crm_private.gmail_enquiry_reply_checks k on k.enquiry_id = e.id
  where e.artist_id = p_artist_id
    and e.archived_at is null and e.intake_state = 'complete'
    and e.created_at >= now() - interval '30 days'
    and nullif(btrim(coalesce(c.email, '')), '') is not null
    -- A complete miss is repeated only while the window can still gain mail;
    -- a closed window (the client enquired again) cannot.
    and (k.enquiry_id is null
         or (not k.found and k.checked_at < now() - interval '6 hours'
             and (w.closed_at is null or not k.complete or k.checked_at < w.closed_at))
         -- Found SENT mail but could not read the whole window (more mail than
         -- one run pages, or a one-page lookup by the earlier Worker build):
         -- try again daily, so the first reply time can still be established.
         or (k.found and not k.complete and k.checked_at < now() - interval '1 day'))
  order by k.checked_at nulls first, e.created_at desc, e.id
  limit p_limit;
end;
$$;

revoke all on function public.service_list_gmail_reply_candidates(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_list_gmail_reply_candidates(uuid, integer) to service_role;
