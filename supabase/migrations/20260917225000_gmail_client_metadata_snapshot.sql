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
alter table public.gmail_client_metadata_snapshot force row level security;

create policy gmail_client_metadata_snapshot_select on public.gmail_client_metadata_snapshot
  for select using (public.can_access_artist(artist_id) and public.can_access_client(client_id));

revoke all on public.gmail_client_metadata_snapshot from public, anon, authenticated;
grant select on public.gmail_client_metadata_snapshot to authenticated;
grant select, insert, update, delete on public.gmail_client_metadata_snapshot to service_role;

comment on table public.gmail_client_metadata_snapshot is
  'Last known Gmail metadata for CRM-known clients. Background service refresh only; no provider ids or bodies.';
