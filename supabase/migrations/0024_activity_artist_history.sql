-- 0024_activity_artist_history.sql
--
-- Preserve composite artist referential integrity for append-only activity
-- history without rewriting old events when current work moves to another
-- artist. Each activity/entity pair is registered in a private event-time
-- history table before the public activity row is inserted.

create table crm_private.activity_enquiry_artist_history (
  enquiry_id uuid not null
    references public.enquiries(id) on delete restrict,
  artist_id uuid not null
    references public.artists(id) on delete restrict,
  first_recorded_at timestamptz not null default now(),
  primary key (enquiry_id, artist_id)
);

create table crm_private.activity_project_artist_history (
  project_id uuid not null
    references public.projects(id) on delete restrict,
  artist_id uuid not null
    references public.artists(id) on delete restrict,
  first_recorded_at timestamptz not null default now(),
  primary key (project_id, artist_id)
);

create table crm_private.activity_session_artist_history (
  session_id uuid not null
    references public.sessions(id) on delete restrict,
  artist_id uuid not null
    references public.artists(id) on delete restrict,
  first_recorded_at timestamptz not null default now(),
  primary key (session_id, artist_id)
);

revoke all on table
  crm_private.activity_enquiry_artist_history,
  crm_private.activity_project_artist_history,
  crm_private.activity_session_artist_history
from public, anon, authenticated, service_role;

insert into crm_private.activity_enquiry_artist_history (enquiry_id, artist_id)
select distinct a.enquiry_id, a.artist_id
from public.activity_log a
where a.enquiry_id is not null
  and a.artist_id is not null
on conflict do nothing;

insert into crm_private.activity_project_artist_history (project_id, artist_id)
select distinct a.project_id, a.artist_id
from public.activity_log a
where a.project_id is not null
  and a.artist_id is not null
on conflict do nothing;

insert into crm_private.activity_session_artist_history (session_id, artist_id)
select distinct a.session_id, a.artist_id
from public.activity_log a
where a.session_id is not null
  and a.artist_id is not null
on conflict do nothing;

create or replace function crm_private.scope_activity_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  v_parent_artist := crm_private.resolve_artist_from_links(
    new.enquiry_id,
    new.project_id,
    new.session_id,
    null,
    new.outbox_id,
    new.enquiry_file_id,
    new.project_file_id
  );

  if new.artist_id is null then
    new.artist_id := v_parent_artist;
  elsif v_parent_artist is not null and new.artist_id <> v_parent_artist then
    raise exception 'activity artist must match every linked entity artist'
      using errcode = '23514';
  end if;

  if new.artist_id is not null then
    if new.enquiry_id is not null then
      insert into crm_private.activity_enquiry_artist_history (
        enquiry_id, artist_id
      ) values (
        new.enquiry_id, new.artist_id
      ) on conflict do nothing;
    end if;

    if new.project_id is not null then
      insert into crm_private.activity_project_artist_history (
        project_id, artist_id
      ) values (
        new.project_id, new.artist_id
      ) on conflict do nothing;
    end if;

    if new.session_id is not null then
      insert into crm_private.activity_session_artist_history (
        session_id, artist_id
      ) values (
        new.session_id, new.artist_id
      ) on conflict do nothing;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.scope_activity_artist()
  from public, anon, authenticated, service_role;

alter table public.activity_log
  add constraint activity_log_enquiry_artist_fkey
  foreign key (enquiry_id, artist_id)
  references crm_private.activity_enquiry_artist_history(enquiry_id, artist_id)
  on delete restrict
  deferrable initially deferred;

alter table public.activity_log
  add constraint activity_log_project_artist_fkey
  foreign key (project_id, artist_id)
  references crm_private.activity_project_artist_history(project_id, artist_id)
  on delete restrict
  deferrable initially deferred;

alter table public.activity_log
  add constraint activity_log_session_artist_fkey
  foreign key (session_id, artist_id)
  references crm_private.activity_session_artist_history(session_id, artist_id)
  on delete restrict
  deferrable initially deferred;

comment on table crm_private.activity_enquiry_artist_history is
  'Append-only event-time enquiry/artist pairs referenced by Activity Log across later owner transfers.';
comment on table crm_private.activity_project_artist_history is
  'Append-only event-time project/artist pairs referenced by Activity Log across later owner transfers.';
comment on table crm_private.activity_session_artist_history is
  'Append-only event-time session/artist pairs referenced by Activity Log across later owner transfers.';
