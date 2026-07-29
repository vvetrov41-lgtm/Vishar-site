-- 0007_rls.sql
--
-- Row level security, table privileges and the finance-column isolation views.
--
-- Two independent layers protect every CRM table:
--
--   1. PRIVILEGES. `anon` holds nothing at all. `authenticated` holds SELECT
--      only, and on `projects` / `sessions` only on the non-finance columns.
--      No role except the migration owner and `service_role` holds INSERT,
--      UPDATE or DELETE on any CRM table: every write goes through a narrow
--      SECURITY DEFINER RPC from migration 0006.
--
--   2. ROW LEVEL SECURITY, enabled and FORCED on every CRM table, so that even
--      the table owner is subject to policy.
--
-- Neither layer relies on the CRM hiding a button.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Start from zero
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable and force RLS everywhere
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'clients', 'enquiries', 'enquiry_files',
    'projects', 'project_files', 'sessions',
    'activity_log', 'internal_notes', 'email_messages', 'follow_ups',
    'integration_outbox', 'enquiry_status_transitions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- profiles
--
-- A staff member sees their own profile. Nobody reads the staff directory
-- through the base table; the owner uses list_profiles() and assignment uses
-- list_assignable_profiles(), both of which minimise the columns returned.
-- ---------------------------------------------------------------------------

grant select on public.profiles to authenticated;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select
  using (
    (id = auth.uid() and is_active)
    -- Owner and booking manager need to see who a piece of work can be assigned
    -- to. This exposes an active colleague's name and role, never a credential,
    -- and never an inactive or read_only account.
    or (public.can_manage_crm() and is_active and role in ('owner', 'booking_manager'))
    or public.is_owner()
    or crm_private.is_service_backend()
  );

-- `no_active_owner()` is what lets the very first owner be promoted without any
-- RLS bypass. It stops being true the moment that owner exists, so it cannot be
-- used again to mint a second one.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert
  with check (
    public.is_owner()
    or crm_private.is_service_backend()
    or crm_private.no_active_owner()
  );

drop policy if exists profiles_update_owner on public.profiles;
create policy profiles_update_owner on public.profiles
  for update
  using (public.is_owner() or crm_private.is_service_backend() or crm_private.no_active_owner())
  with check (public.is_owner() or crm_private.is_service_backend() or crm_private.no_active_owner());

-- Owner-only staff directory. Returns identity and role, never a credential.
create or replace function public.list_profiles()
returns table (
  id uuid,
  email text,
  display_name text,
  role public.crm_role,
  is_active boolean,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_role('owner');
  return query
    select p.id, p.email::text, p.display_name, p.role, p.is_active, p.created_at
    from public.profiles p
    order by p.is_active desc, p.display_name nulls last, p.email;
end;
$$;

-- Minimal directory for the assignment picker: no email, no timestamps.
create or replace function public.list_assignable_profiles()
returns table (id uuid, display_name text, role public.crm_role)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_role('owner', 'booking_manager');
  return query
    select p.id, p.display_name, p.role
    from public.profiles p
    where p.is_active and p.role in ('owner', 'booking_manager')
    order by p.display_name nulls last;
end;
$$;

revoke all on function public.list_profiles() from public;
revoke all on function public.list_assignable_profiles() from public;
grant execute on function public.list_profiles() to authenticated;
grant execute on function public.list_assignable_profiles() to authenticated;

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

grant select on public.clients to authenticated;

drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select
  using (public.is_active_user() or crm_private.is_service_backend());

drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update
  using (public.can_manage_crm() or crm_private.is_service_backend())
  with check (public.can_manage_crm() or crm_private.is_service_backend());

-- No DELETE policy anywhere in this migration. Business records are archived,
-- never hard-deleted, by any role.

-- ---------------------------------------------------------------------------
-- enquiries
-- ---------------------------------------------------------------------------

grant select on public.enquiries to authenticated;

drop policy if exists enquiries_select on public.enquiries;
create policy enquiries_select on public.enquiries
  for select
  using (public.is_active_user() or crm_private.is_service_backend());

drop policy if exists enquiries_insert on public.enquiries;
create policy enquiries_insert on public.enquiries
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists enquiries_update on public.enquiries;
create policy enquiries_update on public.enquiries
  for update
  using (public.can_manage_crm() or crm_private.is_service_backend())
  with check (public.can_manage_crm() or crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- enquiry_files / project_files
--
-- File metadata is operational data: owner and booking manager only.
-- read_only has no file access by default; that is an owner decision recorded
-- in docs/crm/OWNER_SETUP.md and changing it needs a new migration.
-- ---------------------------------------------------------------------------

grant select on public.enquiry_files to authenticated;
grant select on public.project_files to authenticated;

drop policy if exists enquiry_files_select on public.enquiry_files;
create policy enquiry_files_select on public.enquiry_files
  for select
  using (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists enquiry_files_insert on public.enquiry_files;
create policy enquiry_files_insert on public.enquiry_files
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists enquiry_files_update on public.enquiry_files;
create policy enquiry_files_update on public.enquiry_files
  for update
  using (public.can_manage_crm() or crm_private.is_service_backend())
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists project_files_select on public.project_files;
create policy project_files_select on public.project_files
  for select
  using (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists project_files_insert on public.project_files;
create policy project_files_insert on public.project_files
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists project_files_update on public.project_files;
create policy project_files_update on public.project_files
  for update
  using (public.can_manage_crm() or crm_private.is_service_backend())
  with check (public.can_manage_crm() or crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- projects and sessions — finance column isolation
--
-- Row level security cannot hide a column from a role that may select the row,
-- so the money columns are withheld at the privilege level instead. Nobody
-- reads `hourly_rate`, `estimate_total`, `deposit_amount` or `price` through
-- the base table; the owner reads them through the finance views below.
-- ---------------------------------------------------------------------------

grant select (
  id, client_id, enquiry_id, status, title, description,
  estimated_sessions, estimated_hours, deposit_status, currency,
  created_at, updated_at, archived_at
) on public.projects to authenticated;

grant select (
  id, project_id, status, start_at, end_at, duration_hours, currency,
  payment_status, calendar_provider, calendar_event_id, calendar_version,
  notes, created_at, updated_at, cancelled_at
) on public.sessions to authenticated;

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select
  using (public.is_active_user() or crm_private.is_service_backend());

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update
  using (public.can_manage_crm() or crm_private.is_service_backend())
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
  for select
  using (public.is_active_user() or crm_private.is_service_backend());

drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert on public.sessions
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
  for update
  using (public.can_manage_crm() or crm_private.is_service_backend())
  with check (public.can_manage_crm() or crm_private.is_service_backend());

-- Owner-only finance projections. A non-owner selecting these views receives
-- zero rows rather than an error, and still cannot reach the columns directly.
create or replace view public.projects_finance as
  select p.id as project_id,
         p.client_id,
         p.currency,
         p.hourly_rate,
         p.estimate_total,
         p.deposit_amount,
         p.deposit_status
  from public.projects p
  where public.is_owner();

create or replace view public.sessions_finance as
  select s.id as session_id,
         s.project_id,
         s.currency,
         s.price,
         s.payment_status
  from public.sessions s
  where public.is_owner();

grant select on public.projects_finance to authenticated;
grant select on public.sessions_finance to authenticated;

comment on view public.projects_finance is
  'Owner-only finance projection. Non-owners receive zero rows; the base-table columns are not granted to authenticated at all.';

-- ---------------------------------------------------------------------------
-- activity_log
--
-- Append-only for every role. There is deliberately no UPDATE and no DELETE
-- policy on this table, and migration 0005 adds a trigger that also refuses a
-- BYPASSRLS role.
-- ---------------------------------------------------------------------------

grant select, insert on public.activity_log to authenticated;

drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log
  for select
  using (
    public.is_owner()
    -- A booking manager sees the operational trail for entities they work on,
    -- and never the user-management or settings trail.
    or (
      public.can_manage_crm()
      and num_nonnulls(client_id, enquiry_id, project_id, session_id) > 0
      and event_type not like 'profile.%'
      and event_type not like 'owner.%'
      and event_type not like 'settings.%'
    )
    or crm_private.is_service_backend()
  );

drop policy if exists activity_log_insert on public.activity_log;
create policy activity_log_insert on public.activity_log
  for insert
  with check (
    public.is_active_user()
    or crm_private.is_service_backend()
    or crm_private.no_active_owner()   -- the owner.bootstrapped audit event
  );

-- ---------------------------------------------------------------------------
-- internal_notes
-- ---------------------------------------------------------------------------

grant select on public.internal_notes to authenticated;

drop policy if exists internal_notes_select on public.internal_notes;
create policy internal_notes_select on public.internal_notes
  for select
  using (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists internal_notes_insert on public.internal_notes;
create policy internal_notes_insert on public.internal_notes
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists internal_notes_update on public.internal_notes;
create policy internal_notes_update on public.internal_notes
  for update
  using (public.can_manage_crm())
  with check (public.can_manage_crm());

-- ---------------------------------------------------------------------------
-- email_messages
--
-- Message bodies are personalised client correspondence, so read_only has no
-- access at all.
-- ---------------------------------------------------------------------------

grant select on public.email_messages to authenticated;

drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select on public.email_messages
  for select
  using (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists email_messages_insert on public.email_messages;
create policy email_messages_insert on public.email_messages
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists email_messages_update on public.email_messages;
create policy email_messages_update on public.email_messages
  for update
  using (public.is_owner() or crm_private.is_service_backend())
  with check (public.is_owner() or crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- follow_ups
-- ---------------------------------------------------------------------------

grant select on public.follow_ups to authenticated;

drop policy if exists follow_ups_select on public.follow_ups;
create policy follow_ups_select on public.follow_ups
  for select
  using (public.is_active_user() or crm_private.is_service_backend());

drop policy if exists follow_ups_insert on public.follow_ups;
create policy follow_ups_insert on public.follow_ups
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists follow_ups_update on public.follow_ups;
create policy follow_ups_update on public.follow_ups
  for update
  using (public.can_manage_crm() or crm_private.is_service_backend())
  with check (public.can_manage_crm() or crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- integration_outbox
--
-- Owner-visible so failed integration jobs can be seen in the dashboard. The
-- Worker reaches it as service_role, not as a CRM user.
-- ---------------------------------------------------------------------------

grant select on public.integration_outbox to authenticated;

drop policy if exists integration_outbox_select on public.integration_outbox;
create policy integration_outbox_select on public.integration_outbox
  for select
  using (public.is_owner() or crm_private.is_service_backend());

drop policy if exists integration_outbox_insert on public.integration_outbox;
create policy integration_outbox_insert on public.integration_outbox
  for insert
  with check (public.can_manage_crm() or crm_private.is_service_backend());

drop policy if exists integration_outbox_update on public.integration_outbox;
create policy integration_outbox_update on public.integration_outbox
  for update
  using (public.is_owner() or crm_private.is_service_backend())
  with check (public.is_owner() or crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- enquiry_status_transitions (reference data)
-- ---------------------------------------------------------------------------

grant select on public.enquiry_status_transitions to authenticated;

drop policy if exists enquiry_status_transitions_select on public.enquiry_status_transitions;
create policy enquiry_status_transitions_select on public.enquiry_status_transitions
  for select
  using (public.is_active_user() or crm_private.is_service_backend());

-- The transition table is reference data owned by migrations. No write policy
-- exists for any application role.

-- ---------------------------------------------------------------------------
-- service_role
--
-- The trusted Worker reaches the database only through the intake and
-- integration RPCs granted in migration 0006. It is given no table privileges
-- here, so a leaked call path cannot turn into arbitrary table access.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from service_role;
grant select, insert, update on public.integration_outbox to service_role;

comment on schema public is
  'CRM application schema. All writes go through SECURITY DEFINER RPCs; anon holds no privileges.';
