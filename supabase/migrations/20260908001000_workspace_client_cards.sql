-- 20260908001000_workspace_client_cards.sql
--
-- Client cards are tenant data. A person may submit to several independent
-- artists, but one artist must never edit the other artist's client card.
--
-- Existing global client rows are split once per workspace. The migration is
-- deliberately fail-closed for ambiguous client-only records: if production
-- ever contains consent/suppression/client-only note data on a shared client,
-- it must be classified explicitly instead of guessed during rollout.

alter table public.clients
  add column if not exists workspace_id uuid;

-- Build the authoritative set of workspaces in which each existing client has
-- actual CRM work. Audit/outbox rows do not create ownership; they follow the
-- business records below.
create temporary table _client_workspace_scope (
  client_id uuid not null,
  workspace_id uuid not null,
  primary key (client_id, workspace_id)
);

insert into _client_workspace_scope (client_id, workspace_id)
select e.client_id, a.workspace_id
from public.enquiries e
join public.artists a on a.id = e.artist_id
where e.client_id is not null and a.workspace_id is not null
union
select p.client_id, a.workspace_id
from public.projects p
join public.artists a on a.id = p.artist_id
where p.client_id is not null and a.workspace_id is not null
union
select s.client_id, a.workspace_id
from public.sessions s
join public.artists a on a.id = s.artist_id
where s.client_id is not null and a.workspace_id is not null
union
select c.client_id, a.workspace_id
from public.communication_conversations c
join public.artists a on a.id = c.artist_id
where c.client_id is not null and a.workspace_id is not null;

-- Every client must have a tenant before workspace_id becomes mandatory.
do $$
begin
  if exists (
    select 1
    from public.clients c
    where not exists (
      select 1 from _client_workspace_scope s where s.client_id = c.id
    )
  ) then
    raise exception 'workspace client migration found an unscoped client'
      using errcode = '23514';
  end if;
end;
$$;

create temporary table _shared_client_ids (
  client_id uuid primary key
);

insert into _shared_client_ids (client_id)
select client_id
from _client_workspace_scope
group by client_id
having count(*) > 1;

-- These records have no artist/workspace column. Copying or assigning them to
-- one workspace would be a privacy/product decision, so refuse the migration
-- rather than silently make one. Production is checked before rollout too.
do $$
begin
  if exists (
    select 1
    from public.client_marketing_consent x
    join _shared_client_ids s on s.client_id = x.client_id
  ) or exists (
    select 1
    from public.communication_suppressions x
    join _shared_client_ids s on s.client_id = x.client_id
  ) or exists (
    select 1
    from public.internal_notes x
    join _shared_client_ids s on s.client_id = x.client_id
    where x.enquiry_id is null and x.project_id is null and x.session_id is null
  ) or exists (
    select 1
    from public.retention_holds x
    join _shared_client_ids s on s.client_id = x.client_id
    where x.enquiry_id is null and x.project_id is null
  ) then
    raise exception 'shared client has ambiguous client-only records; classify them before tenant split'
      using errcode = '23514';
  end if;
end;
$$;

-- One mapping row per old client/workspace. The lexicographically first
-- workspace keeps the original UUID; all other workspaces receive clones.
create temporary table _client_workspace_map (
  old_client_id uuid not null,
  workspace_id uuid not null,
  new_client_id uuid not null,
  primary key (old_client_id, workspace_id),
  unique (new_client_id)
);

insert into _client_workspace_map (old_client_id, workspace_id, new_client_id)
select client_id,
       workspace_id,
       case when row_number() over (partition by client_id order by workspace_id::text) = 1
            then client_id else gen_random_uuid() end
from _client_workspace_scope;

update public.clients c
set workspace_id = m.workspace_id
from _client_workspace_map m
where m.old_client_id = c.id
  and m.new_client_id = c.id;

insert into public.clients (
  id, workspace_id, full_name, email, phone, instagram, preferred_contact,
  travelling_from, notes_summary, created_at, updated_at, archived_at
)
select m.new_client_id,
       m.workspace_id,
       c.full_name,
       c.email,
       c.phone,
       c.instagram,
       c.preferred_contact,
       c.travelling_from,
       c.notes_summary,
       c.created_at,
       c.updated_at,
       c.archived_at
from _client_workspace_map m
join public.clients c on c.id = m.old_client_id
where m.new_client_id <> m.old_client_id;

-- Re-point every artist-scoped FK to the client card in that artist's
-- workspace. Composite session/enquiry constraints are already deferrable.
update public.enquiries x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.projects x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.sessions x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.communication_conversations x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.follow_ups x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.email_messages x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.integration_outbox x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.payment_requests x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.project_deposit_requests x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.session_deposit_groups x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update public.activity_log x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where x.artist_id is not null
  and a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

update crm_private.gmail_thread_contexts x
set client_id = m.new_client_id
from public.artists a, _client_workspace_map m
where a.id = x.artist_id
  and m.old_client_id = x.client_id
  and m.workspace_id = a.workspace_id
  and x.client_id <> m.new_client_id;

-- Notes/holds with an entity link follow that entity after the split.
update public.internal_notes n
set client_id = coalesce(
  (select e.client_id from public.enquiries e where e.id = n.enquiry_id),
  (select p.client_id from public.projects p where p.id = n.project_id),
  (select s.client_id from public.sessions s where s.id = n.session_id),
  n.client_id
)
where n.client_id in (select client_id from _shared_client_ids);

update public.retention_holds h
set client_id = coalesce(
  (select e.client_id from public.enquiries e where e.id = h.enquiry_id),
  (select p.client_id from public.projects p where p.id = h.project_id),
  h.client_id
)
where h.client_id in (select client_id from _shared_client_ids);

-- Every business row must now have landed on the matching tenant card.
do $$
begin
  if exists (
    select 1
    from public.enquiries e
    join public.artists a on a.id = e.artist_id
    join public.clients c on c.id = e.client_id
    where c.workspace_id is distinct from a.workspace_id
  ) or exists (
    select 1
    from public.projects p
    join public.artists a on a.id = p.artist_id
    join public.clients c on c.id = p.client_id
    where c.workspace_id is distinct from a.workspace_id
  ) or exists (
    select 1
    from public.sessions s
    join public.artists a on a.id = s.artist_id
    join public.clients c on c.id = s.client_id
    where c.workspace_id is distinct from a.workspace_id
  ) or exists (
    select 1
    from public.communication_conversations x
    join public.artists a on a.id = x.artist_id
    join public.clients c on c.id = x.client_id
    where x.client_id is not null
      and c.workspace_id is distinct from a.workspace_id
  ) then
    raise exception 'client workspace split left a cross-workspace business link'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.clients
  alter column workspace_id set not null;

alter table public.clients
  drop constraint if exists clients_workspace_id_fkey;
alter table public.clients
  add constraint clients_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete restrict;

comment on column public.clients.workspace_id is
  'Tenant owner of this client card. The same real person may have separate client cards in separate workspaces.';

-- Replace the global identifier indexes with tenant-aware indexes. They remain
-- non-unique because conflict review and communication-created clients may
-- legitimately coexist until a human resolves them.
drop index if exists public.clients_email_normalized_idx;
drop index if exists public.clients_phone_normalized_idx;
create index if not exists clients_workspace_email_normalized_idx
  on public.clients (workspace_id, email_normalized)
  where archived_at is null and email_normalized is not null;
create index if not exists clients_workspace_phone_normalized_idx
  on public.clients (workspace_id, phone_normalized)
  where archived_at is null and phone_normalized is not null;
create index if not exists clients_workspace_created_at_idx
  on public.clients (workspace_id, created_at desc);

-- Fail closed on future attempts to link an artist-scoped record to a client
-- card owned by another workspace.
create or replace function crm_private.guard_client_workspace_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_client_id uuid;
  v_artist_id uuid;
begin
  v_client_id := nullif(v_row ->> 'client_id', '')::uuid;
  v_artist_id := nullif(v_row ->> 'artist_id', '')::uuid;

  if v_client_id is null or v_artist_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.clients c
    join public.artists a on a.id = v_artist_id
    where c.id = v_client_id
      and c.workspace_id = a.workspace_id
  ) then
    raise exception 'client belongs to a different workspace'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.guard_client_workspace_link()
  from public, anon, authenticated, service_role;

do $$
declare
  v_table regclass;
  v_name text;
begin
  foreach v_name in array array[
    'public.enquiries',
    'public.projects',
    'public.sessions',
    'public.communication_conversations',
    'public.follow_ups',
    'public.email_messages',
    'public.integration_outbox',
    'public.payment_requests',
    'public.project_deposit_requests',
    'public.session_deposit_groups',
    'public.activity_log',
    'crm_private.gmail_thread_contexts'
  ] loop
    v_table := v_name::regclass;
    execute format('drop trigger if exists guard_client_workspace_link on %s', v_table);
    execute format(
      'create trigger guard_client_workspace_link before insert or update of client_id, artist_id on %s for each row execute function crm_private.guard_client_workspace_link()',
      v_table
    );
  end loop;
end;
$$;

-- A workspace-scoped card no longer needs the old "manage every linked artist"
-- safety brake. Cross-workspace sharing is structurally impossible now.
create or replace function crm_private.update_client_details_core(
  p_client_id uuid,
  p_client jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client public.clients%rowtype;
  v_full_name text;
  v_email text;
  v_phone text;
  v_instagram text;
  v_preferred_contact text;
  v_travelling_from text;
  v_changed text[] := '{}'::text[];
  v_artist_id uuid;
  v_actor_kind text;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if p_client_id is null then
    raise exception 'client id is required' using errcode = '22023';
  end if;
  if p_client is null or jsonb_typeof(p_client) <> 'object' then
    raise exception 'client payload must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_client) as k(key)
    where key not in (
      'full_name', 'email', 'phone', 'instagram',
      'preferred_contact', 'travelling_from'
    )
  ) then
    raise exception 'client payload contains an unsupported field' using errcode = '22023';
  end if;

  select * into v_client
  from public.clients c
  where c.id = p_client_id
    and c.archived_at is null
  for update;

  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if not public.can_manage_client(p_client_id) then
    raise exception 'client is outside your managed artist scope' using errcode = '42501';
  end if;

  v_full_name := case when p_client ? 'full_name'
    then left(btrim(coalesce(p_client ->> 'full_name', '')), 160)
    else v_client.full_name end;
  v_email := case when p_client ? 'email'
    then left(nullif(btrim(coalesce(p_client ->> 'email', '')), ''), 320)
    else v_client.email end;
  v_phone := case when p_client ? 'phone'
    then left(nullif(btrim(coalesce(p_client ->> 'phone', '')), ''), 80)
    else v_client.phone end;
  v_instagram := case when p_client ? 'instagram'
    then left(nullif(btrim(coalesce(p_client ->> 'instagram', '')), ''), 80)
    else v_client.instagram end;
  v_preferred_contact := case when p_client ? 'preferred_contact'
    then nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), '')
    else v_client.preferred_contact end;
  v_travelling_from := case when p_client ? 'travelling_from'
    then left(nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), ''), 160)
    else v_client.travelling_from end;

  if v_full_name = '' then
    raise exception 'client full_name is required' using errcode = '22023';
  end if;
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' then
    raise exception 'client email is invalid' using errcode = '22023';
  end if;
  if v_preferred_contact is not null
     and v_preferred_contact not in ('Email', 'WhatsApp', 'Instagram') then
    raise exception 'preferred contact is not permitted' using errcode = '22023';
  end if;

  if v_full_name is distinct from v_client.full_name then v_changed := array_append(v_changed, 'full_name'); end if;
  if v_email is distinct from v_client.email then v_changed := array_append(v_changed, 'email'); end if;
  if v_phone is distinct from v_client.phone then v_changed := array_append(v_changed, 'phone'); end if;
  if v_instagram is distinct from v_client.instagram then v_changed := array_append(v_changed, 'instagram'); end if;
  if v_preferred_contact is distinct from v_client.preferred_contact then v_changed := array_append(v_changed, 'preferred_contact'); end if;
  if v_travelling_from is distinct from v_client.travelling_from then v_changed := array_append(v_changed, 'travelling_from'); end if;

  if cardinality(v_changed) > 0 then
    update public.clients c
    set full_name = v_full_name,
        email = v_email,
        phone = v_phone,
        instagram = v_instagram,
        preferred_contact = v_preferred_contact,
        travelling_from = v_travelling_from,
        updated_at = now()
    where c.id = p_client_id;

    v_actor_kind := case
      when public.is_owner()
        or crm_private.has_workspace_capability(v_client.workspace_id, 'manage_workspace')
      then 'owner' else 'staff' end;

    for v_artist_id in
      select distinct artist_id
      from (
        select e.artist_id from public.enquiries e where e.client_id = p_client_id
        union all
        select p.artist_id from public.projects p where p.client_id = p_client_id
        union all
        select c.artist_id from public.communication_conversations c where c.client_id = p_client_id
      ) scoped
    loop
      perform crm_private.log_artist_activity(
        v_artist_id,
        'client.updated',
        v_actor_kind,
        auth.uid(),
        p_client_id,
        null, null, null, null,
        jsonb_build_object('changed_fields', to_jsonb(v_changed))
      );
    end loop;
  end if;

  return jsonb_build_object(
    'client_id', p_client_id,
    'changed_fields', to_jsonb(v_changed)
  );
end;
$$;

revoke all on function crm_private.update_client_details_core(uuid,jsonb)
  from public, anon, authenticated, service_role;