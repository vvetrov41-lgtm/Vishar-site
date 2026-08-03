-- 0019_artist_scoped_rls.sql
--
-- Replace the original all-active-staff row visibility with artist-scoped
-- policies. The UI may add filters later, but the database is authoritative:
-- omitting or manipulating a filter cannot widen rows.
--
-- Existing SECURITY DEFINER workflow RPCs are updated in migration 0020. Until
-- then they still retain their previous global-role checks, while every direct
-- read is narrowed here and every existing direct write remains blocked by ACL.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Client scope helpers
-- ---------------------------------------------------------------------------

create or replace function public.can_access_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.client_id = p_client_id
        and public.can_access_artist(e.artist_id)
    )
    or exists (
      select 1
      from public.projects p
      where p.client_id = p_client_id
        and public.can_access_artist(p.artist_id)
    );
$$;

create or replace function public.can_manage_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.client_id = p_client_id
        and public.can_manage_artist(e.artist_id)
    )
    or exists (
      select 1
      from public.projects p
      where p.client_id = p_client_id
        and public.can_manage_artist(p.artist_id)
    );
$$;

revoke all on function public.can_access_client(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_manage_client(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_access_client(uuid)
  to authenticated, service_role;
grant execute on function public.can_manage_client(uuid)
  to authenticated, service_role;

comment on function public.can_access_client(uuid) is
  'True only when the current active profile can access at least one artist-scoped enquiry or project linked to the client.';
comment on function public.can_manage_client(uuid) is
  'True only when the current active profile may manage at least one artist-scoped enquiry or project linked to the client.';

-- ---------------------------------------------------------------------------
-- Profiles and shared reference data
-- ---------------------------------------------------------------------------

-- Profile visibility stays self-only except for owners. Artist membership does
-- not expose another staff member's account details.
drop policy if exists profiles_select_self_or_owner on public.profiles;
create policy profiles_select_self_or_owner on public.profiles
  for select
  using (
    crm_private.is_service_backend()
    or (
      public.is_active_user()
      and (id = auth.uid() or public.is_owner())
    )
  );

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------

drop policy if exists clients_select_staff on public.clients;
drop policy if exists clients_insert_manager on public.clients;
drop policy if exists clients_update_manager on public.clients;

drop policy if exists clients_select_artist_scope on public.clients;
create policy clients_select_artist_scope on public.clients
  for select
  using (public.can_access_client(id));

-- Direct table writes still have no browser grants. These policies are narrow
-- defence in depth for any future accidental grant; normal writes use RPCs.
drop policy if exists clients_insert_backend_only on public.clients;
create policy clients_insert_backend_only on public.clients
  for insert
  with check (crm_private.is_service_backend());

drop policy if exists clients_update_artist_scope on public.clients;
create policy clients_update_artist_scope on public.clients
  for update
  using (public.can_manage_client(id))
  with check (public.can_manage_client(id));

-- ---------------------------------------------------------------------------
-- Enquiries and enquiry files
-- ---------------------------------------------------------------------------

drop policy if exists enquiries_select_staff on public.enquiries;
drop policy if exists enquiries_insert_backend on public.enquiries;
drop policy if exists enquiries_update_manager on public.enquiries;

drop policy if exists enquiries_select_artist_scope on public.enquiries;
create policy enquiries_select_artist_scope on public.enquiries
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists enquiries_insert_artist_scope on public.enquiries;
create policy enquiries_insert_artist_scope on public.enquiries
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists enquiries_update_artist_scope on public.enquiries;
create policy enquiries_update_artist_scope on public.enquiries
  for update
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  )
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists enquiry_files_select_manager on public.enquiry_files;
drop policy if exists enquiry_files_insert_backend on public.enquiry_files;
drop policy if exists enquiry_files_update_backend on public.enquiry_files;

drop policy if exists enquiry_files_select_artist_scope on public.enquiry_files;
create policy enquiry_files_select_artist_scope on public.enquiry_files
  for select
  using (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.id = enquiry_files.enquiry_id
        and public.can_manage_artist(e.artist_id)
    )
  );

drop policy if exists enquiry_files_insert_artist_scope on public.enquiry_files;
create policy enquiry_files_insert_artist_scope on public.enquiry_files
  for insert
  with check (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.id = enquiry_files.enquiry_id
        and public.can_manage_artist(e.artist_id)
    )
  );

drop policy if exists enquiry_files_update_artist_scope on public.enquiry_files;
create policy enquiry_files_update_artist_scope on public.enquiry_files
  for update
  using (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.id = enquiry_files.enquiry_id
        and public.can_manage_artist(e.artist_id)
    )
  )
  with check (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.id = enquiry_files.enquiry_id
        and public.can_manage_artist(e.artist_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Projects and project files
-- ---------------------------------------------------------------------------

drop policy if exists projects_select_staff on public.projects;
drop policy if exists projects_insert_manager on public.projects;
drop policy if exists projects_update_manager on public.projects;

drop policy if exists projects_select_artist_scope on public.projects;
create policy projects_select_artist_scope on public.projects
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists projects_insert_artist_scope on public.projects;
create policy projects_insert_artist_scope on public.projects
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists projects_update_artist_scope on public.projects;
create policy projects_update_artist_scope on public.projects
  for update
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  )
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists project_files_select_manager on public.project_files;
drop policy if exists project_files_insert_manager on public.project_files;
drop policy if exists project_files_update_manager on public.project_files;

drop policy if exists project_files_select_artist_scope on public.project_files;
create policy project_files_select_artist_scope on public.project_files
  for select
  using (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.projects p
      where p.id = project_files.project_id
        and public.can_manage_artist(p.artist_id)
    )
  );

drop policy if exists project_files_insert_artist_scope on public.project_files;
create policy project_files_insert_artist_scope on public.project_files
  for insert
  with check (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.projects p
      where p.id = project_files.project_id
        and public.can_manage_artist(p.artist_id)
    )
  );

drop policy if exists project_files_update_artist_scope on public.project_files;
create policy project_files_update_artist_scope on public.project_files
  for update
  using (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.projects p
      where p.id = project_files.project_id
        and public.can_manage_artist(p.artist_id)
    )
  )
  with check (
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.projects p
      where p.id = project_files.project_id
        and public.can_manage_artist(p.artist_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

drop policy if exists sessions_select_staff on public.sessions;
drop policy if exists sessions_insert_manager on public.sessions;
drop policy if exists sessions_update_manager on public.sessions;

drop policy if exists sessions_select_artist_scope on public.sessions;
create policy sessions_select_artist_scope on public.sessions
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists sessions_insert_artist_scope on public.sessions;
create policy sessions_insert_artist_scope on public.sessions
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist_sessions(artist_id)
  );

drop policy if exists sessions_update_artist_scope on public.sessions;
create policy sessions_update_artist_scope on public.sessions
  for update
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist_sessions(artist_id)
  )
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist_sessions(artist_id)
  );

-- ---------------------------------------------------------------------------
-- Activity log
--
-- Read-only profiles continue to see no audit trail. Operational managers see
-- only their artist scope. Finance and integration activity additionally
-- require the matching capability; owner/profile/settings events stay owner-only.
-- ---------------------------------------------------------------------------

drop policy if exists activity_log_select_owner_or_manager on public.activity_log;
drop policy if exists activity_log_insert_manager on public.activity_log;

drop policy if exists activity_log_select_artist_scope on public.activity_log;
create policy activity_log_select_artist_scope on public.activity_log
  for select
  using (
    crm_private.is_service_backend()
    or public.is_owner()
    or (
      public.current_crm_role() = 'booking_manager'
      and artist_id is not null
      and event_type not like 'profile.%'
      and event_type not like 'settings.%'
      and event_type not like 'artist.%'
      and event_type not like 'membership.%'
      and (
        (
          (event_type like 'payment.%' or event_type like 'finance.%')
          and public.can_view_artist_finance(artist_id)
        )
        or (
          event_type like 'integration.%'
          and public.can_manage_artist_integrations(artist_id)
        )
        or (
          event_type not like 'payment.%'
          and event_type not like 'finance.%'
          and event_type not like 'integration.%'
          and public.can_access_artist(artist_id)
        )
      )
    )
  );

drop policy if exists activity_log_insert_artist_scope on public.activity_log;
create policy activity_log_insert_artist_scope on public.activity_log
  for insert
  with check (
    crm_private.is_service_backend()
    or public.is_owner()
    or (
      artist_id is not null
      and public.can_manage_artist(artist_id)
      and event_type not like 'profile.%'
      and event_type not like 'settings.%'
      and event_type not like 'artist.%'
      and event_type not like 'membership.%'
      and event_type not like 'payment.%'
      and event_type not like 'finance.%'
      and event_type not like 'integration.%'
    )
  );

-- ---------------------------------------------------------------------------
-- Internal notes
-- ---------------------------------------------------------------------------

drop policy if exists internal_notes_select_manager on public.internal_notes;
drop policy if exists internal_notes_insert_manager on public.internal_notes;

drop policy if exists internal_notes_select_artist_scope on public.internal_notes;
create policy internal_notes_select_artist_scope on public.internal_notes
  for select
  using (
    crm_private.is_service_backend()
    or (
      public.current_crm_role() in ('owner', 'booking_manager')
      and (
        (client_id is not null and public.can_manage_client(client_id))
        or exists (
          select 1 from public.enquiries e
          where e.id = internal_notes.enquiry_id
            and public.can_manage_artist(e.artist_id)
        )
        or exists (
          select 1 from public.projects p
          where p.id = internal_notes.project_id
            and public.can_manage_artist(p.artist_id)
        )
        or exists (
          select 1 from public.sessions s
          where s.id = internal_notes.session_id
            and public.can_manage_artist(s.artist_id)
        )
      )
    )
  );

drop policy if exists internal_notes_insert_artist_scope on public.internal_notes;
create policy internal_notes_insert_artist_scope on public.internal_notes
  for insert
  with check (
    crm_private.is_service_backend()
    or (
      public.current_crm_role() in ('owner', 'booking_manager')
      and (
        (client_id is not null and public.can_manage_client(client_id))
        or exists (
          select 1 from public.enquiries e
          where e.id = internal_notes.enquiry_id
            and public.can_manage_artist(e.artist_id)
        )
        or exists (
          select 1 from public.projects p
          where p.id = internal_notes.project_id
            and public.can_manage_artist(p.artist_id)
        )
        or exists (
          select 1 from public.sessions s
          where s.id = internal_notes.session_id
            and public.can_manage_artist(s.artist_id)
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Email messages and follow-ups
-- ---------------------------------------------------------------------------

drop policy if exists email_messages_select_manager on public.email_messages;
drop policy if exists email_messages_insert_manager on public.email_messages;
drop policy if exists email_messages_update_manager on public.email_messages;

drop policy if exists email_messages_select_artist_scope on public.email_messages;
create policy email_messages_select_artist_scope on public.email_messages
  for select
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists email_messages_insert_artist_scope on public.email_messages;
create policy email_messages_insert_artist_scope on public.email_messages
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists email_messages_update_artist_scope on public.email_messages;
create policy email_messages_update_artist_scope on public.email_messages
  for update
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  )
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists follow_ups_select_staff on public.follow_ups;
drop policy if exists follow_ups_insert_manager on public.follow_ups;
drop policy if exists follow_ups_update_manager on public.follow_ups;

drop policy if exists follow_ups_select_artist_scope on public.follow_ups;
create policy follow_ups_select_artist_scope on public.follow_ups
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists follow_ups_insert_artist_scope on public.follow_ups;
create policy follow_ups_insert_artist_scope on public.follow_ups
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists follow_ups_update_artist_scope on public.follow_ups;
create policy follow_ups_update_artist_scope on public.follow_ups
  for update
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  )
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

-- ---------------------------------------------------------------------------
-- Integration outbox
-- ---------------------------------------------------------------------------

drop policy if exists integration_outbox_select_manager on public.integration_outbox;
drop policy if exists integration_outbox_insert_manager on public.integration_outbox;
drop policy if exists integration_outbox_update_backend on public.integration_outbox;

drop policy if exists integration_outbox_select_artist_scope on public.integration_outbox;
create policy integration_outbox_select_artist_scope on public.integration_outbox
  for select
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist_integrations(artist_id)
  );

drop policy if exists integration_outbox_insert_artist_scope on public.integration_outbox;
create policy integration_outbox_insert_artist_scope on public.integration_outbox
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist_integrations(artist_id)
  );

drop policy if exists integration_outbox_update_backend on public.integration_outbox;
create policy integration_outbox_update_backend on public.integration_outbox
  for update
  using (crm_private.is_service_backend())
  with check (crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- Artist-scoped legacy finance projections
--
-- These remain temporary compatibility views. Migration 0022 replaces their
-- deposit/payment values with ledger-backed projections.
--
-- PostgreSQL CREATE OR REPLACE VIEW cannot insert a column into an existing
-- view signature. Drop the public wrappers before their private dependencies,
-- then recreate the four compatibility views with artist_id.
-- ---------------------------------------------------------------------------

drop view if exists public.projects_finance;
drop view if exists public.sessions_finance;
drop view if exists crm_private.projects_finance_source;
drop view if exists crm_private.sessions_finance_source;

create view crm_private.projects_finance_source
with (security_barrier = true) as
  select p.id as project_id,
         p.artist_id,
         p.client_id,
         p.currency,
         p.hourly_rate,
         p.estimate_total,
         p.deposit_amount,
         p.deposit_status
  from public.projects p
  where public.can_view_artist_finance(p.artist_id);

create view crm_private.sessions_finance_source
with (security_barrier = true) as
  select s.id as session_id,
         s.artist_id,
         s.project_id,
         s.currency,
         s.price,
         s.payment_status
  from public.sessions s
  where public.can_view_artist_finance(s.artist_id);

revoke all on crm_private.projects_finance_source
  from public, anon, authenticated, service_role;
revoke all on crm_private.sessions_finance_source
  from public, anon, authenticated, service_role;
grant select on crm_private.projects_finance_source to authenticated;
grant select on crm_private.sessions_finance_source to authenticated;

create view public.projects_finance
with (security_barrier = true, security_invoker = true) as
  select project_id,
         artist_id,
         client_id,
         currency,
         hourly_rate,
         estimate_total,
         deposit_amount,
         deposit_status
  from crm_private.projects_finance_source;

create view public.sessions_finance
with (security_barrier = true, security_invoker = true) as
  select session_id,
         artist_id,
         project_id,
         currency,
         price,
         payment_status
  from crm_private.sessions_finance_source;

revoke all on public.projects_finance
  from public, anon, authenticated, service_role;
revoke all on public.sessions_finance
  from public, anon, authenticated, service_role;
grant select on public.projects_finance to authenticated;
grant select on public.sessions_finance to authenticated;

comment on view public.projects_finance is
  'Artist-scoped SECURITY INVOKER compatibility projection. Rows require can_view_finance for the matching artist.';
comment on view public.sessions_finance is
  'Artist-scoped SECURITY INVOKER compatibility projection. Rows require can_view_finance for the matching artist.';

-- ---------------------------------------------------------------------------
-- Artist-scoped private Storage object checks
-- ---------------------------------------------------------------------------

create or replace function public.crm_storage_object_is_known(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiry_files f
      join public.enquiries e on e.id = f.enquiry_id
      where f.storage_object_path = p_name
        and f.storage_object_path like 'enquiries/' || f.enquiry_id::text || '/' || f.id::text || '.%'
        and public.can_manage_artist(e.artist_id)
    )
    or exists (
      select 1
      from public.project_files f
      join public.projects p on p.id = f.project_id
      where f.storage_object_path = p_name
        and f.storage_object_path like 'projects/' || f.project_id::text || '/' || f.id::text || '.%'
        and public.can_manage_artist(p.artist_id)
    );
$$;

create or replace function public.crm_storage_object_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select public.crm_storage_object_is_known(p_name);
$$;

create or replace function public.crm_storage_object_writable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiry_files f
      join public.enquiries e on e.id = f.enquiry_id
      where f.storage_object_path = p_name
        and f.upload_state <> 'ready'
        and f.storage_object_path like 'enquiries/' || f.enquiry_id::text || '/' || f.id::text || '.%'
        and public.can_manage_artist(e.artist_id)
    )
    or exists (
      select 1
      from public.project_files f
      join public.projects p on p.id = f.project_id
      where f.storage_object_path = p_name
        and f.storage_object_path like 'projects/' || f.project_id::text || '/' || f.id::text || '.%'
        and public.can_manage_artist(p.artist_id)
    );
$$;

-- Preserve the established explicit callable surface.
revoke all on function public.crm_storage_object_is_known(text)
  from public, anon, authenticated, service_role;
revoke all on function public.crm_storage_object_readable(text)
  from public, anon, authenticated, service_role;
revoke all on function public.crm_storage_object_writable(text)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_storage_object_is_known(text)
  to authenticated, service_role;
grant execute on function public.crm_storage_object_readable(text)
  to authenticated, service_role;
grant execute on function public.crm_storage_object_writable(text)
  to authenticated, service_role;

comment on function public.crm_storage_object_is_known(text) is
  'True only for a canonical manifest-backed CRM object inside an artist scope the caller may manage, or for the trusted backend.';

-- Existing storage.objects policies already delegate SELECT/INSERT checks to
-- these helpers. Replace UPDATE/DELETE owner-wide predicates with explicit
-- canonical-path checks while keeping destructive operations owner/backend-only.
drop policy if exists crm_private_images_update on storage.objects;
create policy crm_private_images_update on storage.objects
  for update
  using (
    bucket_id = 'crm-private-images'
    and (public.is_owner() or crm_private.is_service_backend())
    and public.crm_storage_object_is_known(name)
  )
  with check (
    bucket_id = 'crm-private-images'
    and (public.is_owner() or crm_private.is_service_backend())
    and public.crm_storage_object_is_known(name)
  );

drop policy if exists crm_private_images_delete on storage.objects;
create policy crm_private_images_delete on storage.objects
  for delete
  using (
    bucket_id = 'crm-private-images'
    and (public.is_owner() or crm_private.is_service_backend())
    and public.crm_storage_object_is_known(name)
  );
