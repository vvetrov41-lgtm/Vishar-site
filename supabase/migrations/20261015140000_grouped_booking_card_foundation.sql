
-- Group existing paid session-deposit members into ONE immutable booking-card snapshot.
-- Existing delivered cards (including Aaron's) remain untouched.
create table crm_private.booking_card_groups (
  group_id uuid primary key references public.session_deposit_groups(id) on delete restrict,
  anchor_card_id uuid not null unique references crm_private.booking_cards(id) on delete restrict,
  member_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  constraint booking_card_group_member_shape check (
    jsonb_typeof(member_snapshot) = 'array'
    and jsonb_array_length(member_snapshot) between 2 and 12
  )
);
create table crm_private.booking_card_group_action_tokens (
  token_id uuid primary key references crm_private.appointment_client_action_tokens(id) on delete cascade,
  group_id uuid not null references crm_private.booking_card_groups(group_id) on delete restrict
);
revoke all on crm_private.booking_card_groups, crm_private.booking_card_group_action_tokens
  from public, anon, authenticated, service_role;

create or replace function crm_private.booking_group_card_valid(p_card_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_group crm_private.booking_card_groups%rowtype;
begin
  if p_card_id is null then return false; end if;
  select * into v_group from crm_private.booking_card_groups where anchor_card_id=p_card_id;
  if not found then return true; end if;
  return exists (
    select 1 from public.session_deposit_groups g
    join public.payment_requests p on p.id=g.payment_request_id
    join crm_private.booking_cards anchor on anchor.id=v_group.anchor_card_id
    where g.id=v_group.group_id and p.status='paid' and anchor.superseded_at is null
      and g.session_count=jsonb_array_length(v_group.member_snapshot)
      and (select count(*) from public.session_deposit_group_members m
           where m.group_id=g.id and m.released_at is null)=g.session_count
      and not exists (
        select 1 from jsonb_to_recordset(v_group.member_snapshot) as snap(
          session_id uuid,card_id uuid,calendar_version integer,start_at timestamptz,end_at timestamptz
        )
        left join public.session_deposit_group_members m
          on m.group_id=g.id and m.session_id=snap.session_id and m.released_at is null
        left join public.sessions s on s.id=snap.session_id
        left join crm_private.booking_cards b on b.id=snap.card_id
        where m.session_id is null or s.id is null or b.id is null
          or s.artist_id is distinct from g.artist_id or s.client_id is distinct from g.client_id
          or s.status<>'confirmed' or s.start_at<=now()
          or s.calendar_version is distinct from snap.calendar_version
          or s.start_at is distinct from snap.start_at or s.end_at is distinct from snap.end_at
          or b.session_id is distinct from s.id or b.superseded_at is not null
          or b.calendar_version is distinct from s.calendar_version
          or b.card_kind<>'tattoo_deposit_paid'
      )
  );
end;
$$;
revoke all on function crm_private.booking_group_card_valid(uuid)
from public, anon, authenticated, service_role;

create or replace function crm_private.booking_group_card_summary(p_card_id uuid)
returns table(session_count integer, dates_text text, dates_compact text, times_compact text,
  total_deposit numeric, total_remaining numeric)
language sql stable security definer set search_path=pg_catalog,public,crm_private
as $$
select count(*)::integer,
  string_agg(to_char(b.start_at at time zone b.timezone,'FMDay, FMDD FMMonth YYYY')
    || ' · ' || to_char(b.start_at at time zone b.timezone,'HH24:MI')
    || '–' || to_char(b.end_at at time zone b.timezone,'HH24:MI'), E'\n' order by b.start_at,b.id),
  string_agg(to_char(b.start_at at time zone b.timezone,'FMDD Mon YYYY'), ', ' order by b.start_at,b.id),
  case when count(distinct to_char(b.start_at at time zone b.timezone,'HH24:MI') || '/'
                             || to_char(b.end_at at time zone b.timezone,'HH24:MI'))=1
       then min(to_char(b.start_at at time zone b.timezone,'HH24:MI') || '–'
                             || to_char(b.end_at at time zone b.timezone,'HH24:MI')) || ' each'
       else 'see individual dates' end,
  sum(b.deposit_paid),sum(b.remaining_balance)
from crm_private.booking_card_groups g
join lateral jsonb_to_recordset(g.member_snapshot) as m(
  session_id uuid,card_id uuid,calendar_version integer,start_at timestamptz,end_at timestamptz
) on true
join crm_private.booking_cards b on b.id=m.card_id
where g.anchor_card_id=p_card_id
  and crm_private.booking_group_card_valid(p_card_id)
group by g.group_id;
$$;
revoke all on function crm_private.booking_group_card_summary(uuid)
from public, anon, authenticated, service_role;

-- NULL: an intact paid group is still waiting for all member cards.
-- Original ID: solo booking or a legacy partially sent group (never resend Aaron).
-- Anchor ID: all cards are ready; only this card may dispatch.
create or replace function crm_private.booking_group_card_anchor(p_card_id uuid)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public,crm_private
as $$
declare v_group public.session_deposit_groups%rowtype;
 v_anchor uuid; v_snapshot jsonb; v_ready integer; v_sent integer; v_sum numeric;
begin
  select g.* into v_group from crm_private.booking_cards b
  join public.session_deposit_group_members m on m.session_id=b.session_id and m.released_at is null
  join public.session_deposit_groups g on g.id=m.group_id
  join public.payment_requests p on p.id=g.payment_request_id and p.status='paid'
  where b.id=p_card_id and b.superseded_at is null
    and b.card_kind='tattoo_deposit_paid' and g.session_count between 2 and 12
  order by g.created_at desc limit 1;
  if not found then return p_card_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('booking-group:' || v_group.id::text,0));
  select anchor_card_id into v_anchor from crm_private.booking_card_groups where group_id=v_group.id;
  if found then
    if crm_private.booking_group_card_valid(v_anchor) then return v_anchor; end if;
    -- A changed member must not re-send the old group or duplicate a paid booking.
    return p_card_id;
  end if;
  select count(*),count(d.id),sum(b.deposit_paid),
    jsonb_agg(jsonb_build_object('session_id',s.id,'card_id',b.id,
      'calendar_version',s.calendar_version,'start_at',s.start_at,'end_at',s.end_at)
      order by s.start_at,s.id)
  into v_ready,v_sent,v_sum,v_snapshot
  from public.session_deposit_group_members m
  join public.sessions s on s.id=m.session_id
  left join crm_private.booking_cards b on b.session_id=s.id
    and b.superseded_at is null and b.card_kind='tattoo_deposit_paid'
    and b.artist_id=v_group.artist_id and b.client_id=v_group.client_id
    and b.calendar_version=s.calendar_version and s.status='confirmed' and s.start_at>now()
  left join crm_private.booking_card_deliveries d on d.booking_card_id=b.id
  where m.group_id=v_group.id and m.released_at is null;
  -- A prior delivery is an immutable legacy booking. Never add a group to it.
  if v_sent>0 then return p_card_id; end if;
  if v_ready<>v_group.session_count or jsonb_array_length(v_snapshot)<>v_group.session_count
     or exists (select 1 from jsonb_array_elements(v_snapshot) x where x->>'card_id' is null)
     or v_sum is distinct from v_group.total_amount then
    return null;
  end if;
  select b.id into v_anchor from crm_private.booking_cards b
  join public.session_deposit_group_members m on m.session_id=b.session_id and m.group_id=v_group.id
  where b.superseded_at is null and b.card_kind='tattoo_deposit_paid'
  order by b.start_at,b.id limit 1;
  insert into crm_private.booking_card_groups(group_id,anchor_card_id,member_snapshot)
  values (v_group.id,v_anchor,v_snapshot) on conflict(group_id) do nothing;
  return v_anchor;
end;
$$;
revoke all on function crm_private.booking_group_card_anchor(uuid)
from public, anon, authenticated, service_role;
