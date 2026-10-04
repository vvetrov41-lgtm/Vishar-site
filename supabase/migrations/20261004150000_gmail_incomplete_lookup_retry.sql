-- 20261004150000_gmail_incomplete_lookup_retry.sql
--
-- A Gmail first-reply lookup that found SENT mail but did not read the whole
-- enquiry window (complete = false) was never repeated, so that enquiry kept
-- an unknown first reply time for good. On production four such rows were
-- written between the 20261004120000 database release and the Gmail Worker
-- redeploy, by the one-page Worker build through the three-argument record
-- function. They are now looked up again daily.
--
-- A retry must make progress, and must not lose a proven answer:
--   * the oldest SENT message found so far is kept (oldest_seen_at), and the
--     next lookup only searches before it, so a window larger than one run
--     is read a few pages further back each time;
--   * a lookup that reads its (narrowed) window in full and finds nothing
--     earlier makes oldest_seen_at the first reply;
--   * a complete lookup that finds nothing never turns a prior positive back
--     into "not found".

alter table crm_private.gmail_enquiry_reply_checks
  add column oldest_seen_at timestamptz;

comment on column crm_private.gmail_enquiry_reply_checks.oldest_seen_at is
  'Oldest SENT message to the client in the enquiry window seen by an incomplete lookup. The next lookup searches only before it.';

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
  -- closed_at is the upper bound of the search: the window end, narrowed to
  -- the oldest SENT mail an incomplete lookup already saw.
  select e.id, lower(btrim(c.email)), e.created_at,
         case when k.found and not k.complete and k.oldest_seen_at is not null
              then least(coalesce(w.closed_at, k.oldest_seen_at), k.oldest_seen_at)
              else w.closed_at end
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


create or replace function public.service_record_gmail_enquiry_reply_check(
  p_artist_id uuid,
  p_enquiry_id uuid,
  p_first_sent_at timestamptz,
  p_complete boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry record;
  v_prior record;
  v_complete boolean := coalesce(p_complete, false);
  v_first timestamptz;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail reply recording is backend-only' using errcode = '42501';
  end if;
  select e.id, e.client_id, e.created_at into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id and e.artist_id = p_artist_id;
  if not found then
    raise exception 'Gmail reply target is unavailable' using errcode = '22023';
  end if;
  if p_first_sent_at is not null and p_first_sent_at > now() + interval '5 minutes' then
    raise exception 'invalid Gmail reply time' using errcode = '22023';
  end if;

  select k.found, k.complete, k.oldest_seen_at into v_prior
  from crm_private.gmail_enquiry_reply_checks k
  where k.enquiry_id = p_enquiry_id
  for update;

  if v_complete then
    -- The (narrowed) window was read in full: its oldest SENT message, or
    -- else the oldest one an earlier pass saw, is the first Gmail reply.
    v_first := coalesce(p_first_sent_at, v_prior.oldest_seen_at);
    if v_first is not null then
      perform crm_private.note_gmail_client_outbound(p_artist_id, v_enquiry.client_id, v_first);
    end if;
  end if;

  insert into crm_private.gmail_enquiry_reply_checks (
    enquiry_id, artist_id, checked_at, found, complete, oldest_seen_at
  ) values (
    p_enquiry_id, p_artist_id, now(), p_first_sent_at is not null, v_complete,
    case when not v_complete then p_first_sent_at end
  )
  on conflict (enquiry_id) do update
  set checked_at = excluded.checked_at,
      found = crm_private.gmail_enquiry_reply_checks.found or excluded.found,
      oldest_seen_at = case
        when excluded.complete then crm_private.gmail_enquiry_reply_checks.oldest_seen_at
        else least(crm_private.gmail_enquiry_reply_checks.oldest_seen_at, excluded.oldest_seen_at)
      end,
      complete = case
        -- A complete lookup that found the first reply stays the answer.
        when crm_private.gmail_enquiry_reply_checks.complete and crm_private.gmail_enquiry_reply_checks.found then true
        -- A prior positive without any time cannot be completed by a lookup
        -- that finds nothing: it stays "answered, time unknown".
        when excluded.complete and not excluded.found
             and crm_private.gmail_enquiry_reply_checks.found
             and crm_private.gmail_enquiry_reply_checks.oldest_seen_at is null then false
        else excluded.complete
      end;
end;
$$;

revoke all on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz, boolean) to service_role;
