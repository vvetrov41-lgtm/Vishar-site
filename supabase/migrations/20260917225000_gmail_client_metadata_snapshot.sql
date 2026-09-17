-- Cached Gmail metadata for known clients. Provider ids and message bodies never enter this table.
create table public.gmail_client_metadata_snapshot (
  artist_id uuid not null references public.artists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  subject text not null default '',
  last_message_at timestamptz,
  direction text not null check (direction in ('inbound','outbound')),
  refreshed_at timestamptz not null default now(),
  primary key (artist_id, client_id),
  constraint gmail_client_metadata_subject_length check (length(subject) <= 998)
);

create index gmail_client_metadata_recent_idx
  on public.gmail_client_metadata_snapshot (artist_id, last_message_at desc nulls last);

alter table public.gmail_client_metadata_snapshot enable row level security;

create policy gmail_client_metadata_snapshot_select on public.gmail_client_metadata_snapshot
  for select using (public.can_access_artist(artist_id) and public.can_access_client(client_id));

revoke all on public.gmail_client_metadata_snapshot from public, anon, authenticated;
grant select on public.gmail_client_metadata_snapshot to authenticated;
grant select, insert, update, delete on public.gmail_client_metadata_snapshot to service_role;

create or replace function public.service_replace_gmail_client_metadata_snapshot(
  p_artist_id uuid,
  p_clients jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_count integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail metadata refresh is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or jsonb_typeof(coalesce(p_clients, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid Gmail metadata snapshot' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_clients, '[]'::jsonb)) > 1000 then
    raise exception 'Gmail metadata snapshot too large' using errcode = '22023';
  end if;

  create temporary table if not exists pg_temp.gmail_snapshot_stage (
    client_id uuid primary key,
    subject text not null,
    last_message_at timestamptz,
    direction text not null
  ) on commit drop;
  truncate pg_temp.gmail_snapshot_stage;

  insert into pg_temp.gmail_snapshot_stage(client_id, subject, last_message_at, direction)
  select x.client_id, left(coalesce(x.subject, ''), 998), x.last_message_at, x.direction
  from jsonb_to_recordset(coalesce(p_clients, '[]'::jsonb))
    as x(client_id uuid, subject text, last_message_at timestamptz, direction text)
  where x.client_id is not null
    and x.direction in ('inbound','outbound')
    and exists (
      select 1 from public.enquiries e
      where e.artist_id = p_artist_id and e.client_id = x.client_id
    );

  insert into public.gmail_client_metadata_snapshot(
    artist_id, client_id, subject, last_message_at, direction, refreshed_at
  )
  select p_artist_id, s.client_id, s.subject, s.last_message_at, s.direction, now()
  from pg_temp.gmail_snapshot_stage s
  on conflict (artist_id, client_id) do update
    set subject = excluded.subject,
        last_message_at = excluded.last_message_at,
        direction = excluded.direction,
        refreshed_at = excluded.refreshed_at;

  get diagnostics v_count = row_count;

  delete from public.gmail_client_metadata_snapshot g
  where g.artist_id = p_artist_id
    and not exists (select 1 from pg_temp.gmail_snapshot_stage s where s.client_id = g.client_id);

  return v_count;
end;
$function$;

revoke all on function public.service_replace_gmail_client_metadata_snapshot(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_replace_gmail_client_metadata_snapshot(uuid, jsonb)
  to service_role;

comment on table public.gmail_client_metadata_snapshot is
  'Last known Gmail metadata for CRM-known clients. Background service refresh only; no provider ids or bodies.';
