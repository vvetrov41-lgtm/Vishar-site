-- Google review request, phase 1: who to ask how their tattoo healed.
--
-- Happy clients rarely leave a Google review unless asked, and asking
-- mid-project or while a tattoo heals badly hurts. Vladimir's rule
-- (2026-11-16): first ask how the tattoo healed, ask for a review only after
-- the client replies, and both steps are suggestions the artist sends by hand.
-- See specs/google-review-request/spec.md.
--
-- This migration adds the data and the read/decision RPCs only. It sends
-- nothing, queues nothing and adds no UI:
--
-- * crm_private.artist_review_settings: each artist's own Google review link,
--   seeded from the artists' sites.
-- * public.review_requests: one row per anchor visit once the artist acts on
--   a suggestion (later / don't ask; later phases add the send states).
-- * public.list_review_suggestions(artist): clients whose last tattoo visit
--   was attended 28+ days ago (within 180 days), with nothing booked after
--   it, never asked for a review, not suppressed, not snoozed or dismissed,
--   each with a draft healing question.
-- * public.act_on_review_suggestion(artist, anchor, action, operation):
--   'snooze' (hide for 1-60 days, default 14) or 'dismiss' (never for that
--   visit). Idempotent per operation id: every processed operation is
--   recorded, so a late retry never overwrites a later decision.

create table crm_private.artist_review_settings (
  artist_id uuid primary key references public.artists(id) on delete cascade,
  google_review_url text not null check (
    char_length(google_review_url) <= 300
    and google_review_url ~ '^https://(g\.page/r/[A-Za-z0-9_-]+/review|search\.google\.com/local/writereview\?placeid=[A-Za-z0-9_-]+)$'
  ),
  updated_at timestamptz not null default now()
);

alter table crm_private.artist_review_settings enable row level security;
alter table crm_private.artist_review_settings force row level security;
revoke all on table crm_private.artist_review_settings from public, anon, authenticated, service_role;

-- Links as published on vishartattoo.com and kristinavishar.com.
insert into crm_private.artist_review_settings (artist_id, google_review_url)
select a.id, v.url
from (values
  ('vladimir', 'https://g.page/r/CRBB4T36uQ6wEBI/review'),
  ('kristina', 'https://g.page/r/CTWQsqzepVfJEBI/review')
) v(slug, url)
join public.artists a on a.slug = v.slug
on conflict (artist_id) do nothing;

create table public.review_requests (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- The last attended visit of the block the question is about.
  anchor_session_id uuid not null unique references public.sessions(id) on delete cascade,
  state text not null check (state in (
    'snoozed', 'dismissed', 'healing_asked', 'replied', 'review_asked', 'closed')),
  snoozed_until timestamptz,
  healing_asked_at timestamptz,
  replied_at timestamptz,
  review_asked_at timestamptz,
  closed_at timestamptz,
  last_operation_id uuid not null,
  version integer not null default 1 check (version >= 1),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_requests_snooze_shape check ((state = 'snoozed') = (snoozed_until is not null))
);

create index review_requests_artist_client_idx on public.review_requests (artist_id, client_id);

-- Every processed decision, so a delayed retry of an earlier operation
-- returns its recorded result instead of overwriting a later decision.
create table crm_private.review_request_operations (
  operation_id uuid primary key,
  review_request_id uuid not null references public.review_requests(id) on delete cascade,
  action text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

alter table crm_private.review_request_operations enable row level security;
alter table crm_private.review_request_operations force row level security;
revoke all on table crm_private.review_request_operations from public, anon, authenticated, service_role;

alter table public.review_requests enable row level security;
alter table public.review_requests force row level security;
revoke all on table public.review_requests from public, anon, authenticated, service_role;

-- English (clients write in English). Same text as the WhatsApp Utility
-- template vishar_healing_check_v1.
create or replace function crm_private.healing_question_draft(p_client_name text)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select 'Hi' || coalesce(' ' || nullif(split_part(btrim(coalesce(p_client_name, '')), ' ', 1), ''), '')
    || ', I hope all is well with you. How has your tattoo healed?';
$fn$;

create or replace function crm_private.review_suggestions(
  p_artist_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  with attended as (
    select vo.client_id, vo.session_id, vo.work_result, s.start_at, s.project_id,
      row_number() over (partition by vo.client_id order by s.start_at desc, s.id desc) as rn
    from public.visit_outcomes vo
    join public.sessions s on s.id = vo.session_id
    where vo.artist_id = p_artist_id
      and s.artist_id = p_artist_id
      and vo.state = 'confirmed'
      and vo.outcome = 'attended'
      and vo.appointment_type in ('tattoo_session', 'touch_up')
  ),
  anchor as (
    select a.* from attended a
    where a.rn = 1
      -- Mid-project: the next-session nudge on Today covers it.
      and a.work_result is distinct from 'next_session_needed'
      and a.start_at <= p_now - interval '28 days'
      and a.start_at > p_now - interval '180 days'
  ),
  eligible as (
    select an.*, c.full_name, c.preferred_contact, p.title as project_title
    from anchor an
    join public.clients c on c.id = an.client_id
    left join public.projects p on p.id = an.project_id
    where c.archived_at is null
      -- Any later visit, booked or already done (sessions are auto-completed
      -- before their outcome is recorded), means the block is not over or the
      -- newest tattoo has not healed long enough. A later visit recorded as a
      -- no-show or cancelled leaves nothing new to heal.
      and not exists (
        select 1 from public.sessions n
        left join public.projects np on np.id = n.project_id
        where n.artist_id = p_artist_id
          and coalesce(n.client_id, np.client_id) = an.client_id
          and n.appointment_type in ('tattoo_session', 'touch_up')
          and n.status in ('draft', 'proposed', 'confirmed', 'completed')
          and n.cancelled_at is null
          and n.start_at > an.start_at
          and not exists (
            select 1 from public.visit_outcomes nvo
            where nvo.session_id = n.id and nvo.state = 'confirmed'
              and nvo.outcome in ('no_show', 'cancelled'))
      )
      and not exists (
        select 1 from public.communication_suppressions cs
        where cs.client_id = an.client_id and cs.is_active
          and cs.reason in ('unsubscribed', 'complained', 'blocked', 'manual')
      )
      -- Decided for this visit: snoozed until later, dismissed or already asked.
      and not exists (
        select 1 from public.review_requests rr
        where rr.anchor_session_id = an.session_id
          and (rr.state <> 'snoozed' or rr.snoozed_until > p_now)
      )
      -- One review request per client; an open healing question also counts.
      and not exists (
        select 1 from public.review_requests rr
        where rr.artist_id = p_artist_id and rr.client_id = an.client_id
          and (rr.review_asked_at is not null or rr.state in ('healing_asked', 'replied'))
      )
  )
  select jsonb_build_object(
    'artist_id', p_artist_id,
    'review_url_configured', exists (
      select 1 from crm_private.artist_review_settings rs where rs.artist_id = p_artist_id),
    'suggestions', coalesce((
      select jsonb_agg(jsonb_build_object(
          'client_id', e.client_id,
          'client_name', left(e.full_name, 120),
          'anchor_session_id', e.session_id,
          'project_id', e.project_id,
          'project_title', left(e.project_title, 120),
          'last_session_at', e.start_at,
          'days_since', floor(extract(epoch from (p_now - e.start_at)) / 86400)::int,
          'work_result', e.work_result,
          'preferred_contact', e.preferred_contact,
          'draft_message', crm_private.healing_question_draft(e.full_name)
        ) order by e.start_at, e.client_id)
      from (select * from eligible order by start_at, client_id limit 50) e
    ), '[]'::jsonb)
  );
$fn$;

revoke all on function crm_private.healing_question_draft(text) from public, anon, authenticated, service_role;
revoke all on function crm_private.review_suggestions(uuid, timestamptz) from public, anon, authenticated, service_role;

create or replace function public.list_review_suggestions(p_artist_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_clients');
  perform crm_private.require_artist_access(p_artist_id, 'view_sessions');
  return crm_private.review_suggestions(p_artist_id, clock_timestamp());
end;
$fn$;

revoke all on function public.list_review_suggestions(uuid) from public, anon, service_role;
grant execute on function public.list_review_suggestions(uuid) to authenticated;

create or replace function public.act_on_review_suggestion(
  p_artist_id uuid,
  p_anchor_session_id uuid,
  p_action text,
  p_operation_id uuid,
  p_snooze_days integer default 14
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_client uuid;
  v_now timestamptz := clock_timestamp();
  v_row public.review_requests%rowtype;
  v_result jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'send_communications');

  if p_operation_id is null then
    raise exception 'an operation id is required' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('snooze', 'dismiss') then
    raise exception 'unsupported review suggestion action' using errcode = '22023';
  end if;
  if p_action = 'snooze' and (p_snooze_days is null or p_snooze_days not between 1 and 60) then
    raise exception 'snooze days must be between 1 and 60' using errcode = '22023';
  end if;

  -- The anchor must be an attended tattoo visit of this artist.
  select vo.client_id into v_client
  from public.visit_outcomes vo
  join public.sessions s on s.id = vo.session_id
  where vo.session_id = p_anchor_session_id
    and vo.artist_id = p_artist_id and s.artist_id = p_artist_id
    and vo.state = 'confirmed' and vo.outcome = 'attended'
    and vo.appointment_type in ('tattoo_session', 'touch_up');
  if not found then
    raise exception 'visit is not an attended tattoo visit of this artist' using errcode = '23503';
  end if;

  -- Serialise every decision on this visit, including the first one, when no
  -- row exists yet to lock: concurrent first calls and retries wait here and
  -- then see the recorded row and operation instead of a unique violation.
  perform pg_advisory_xact_lock(hashtextextended('review_request:' || p_anchor_session_id::text, 0));

  select * into v_row from public.review_requests
  where anchor_session_id = p_anchor_session_id
  for update;

  select o.result into v_result
  from crm_private.review_request_operations o
  join public.review_requests r on r.id = o.review_request_id
  where o.operation_id = p_operation_id;
  if found then
    if v_result ->> 'anchor_session_id' <> p_anchor_session_id::text
       or v_result ->> 'artist_id' <> p_artist_id::text then
      raise exception 'operation id was used for another visit' using errcode = '22023';
    end if;
    return v_result;
  end if;

  if v_row.id is not null then
    if v_row.state not in ('snoozed', 'dismissed') then
      raise exception 'healing question already sent for this visit' using errcode = '55000';
    end if;
    update public.review_requests set
      state = case p_action when 'snooze' then 'snoozed' else 'dismissed' end,
      snoozed_until = case when p_action = 'snooze' then v_now + make_interval(days => p_snooze_days) end,
      last_operation_id = p_operation_id,
      version = version + 1,
      updated_by = auth.uid(),
      updated_at = v_now
    where id = v_row.id
    returning * into v_row;
  else
    insert into public.review_requests (
      artist_id, client_id, anchor_session_id, state, snoozed_until,
      last_operation_id, created_by, updated_by, created_at, updated_at
    ) values (
      p_artist_id, v_client, p_anchor_session_id,
      case p_action when 'snooze' then 'snoozed' else 'dismissed' end,
      case when p_action = 'snooze' then v_now + make_interval(days => p_snooze_days) end,
      p_operation_id, auth.uid(), auth.uid(), v_now, v_now
    )
    returning * into v_row;
  end if;

  v_result := to_jsonb(v_row) - 'created_by' - 'updated_by';
  insert into crm_private.review_request_operations (operation_id, review_request_id, action, result)
  values (p_operation_id, v_row.id, p_action, v_result);
  return v_result;
end;
$fn$;

revoke all on function public.act_on_review_suggestion(uuid, uuid, text, uuid, integer) from public, anon, service_role;
grant execute on function public.act_on_review_suggestion(uuid, uuid, text, uuid, integer) to authenticated;
