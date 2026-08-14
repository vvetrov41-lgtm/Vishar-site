-- 0010_retention_settings.sql
--
-- Owner-only system settings, with data retention DISABLED and every duration
-- NULL.
--
-- No retention period is invented here. Choosing one is an owner decision
-- (docs/crm/OWNER_SETUP.md decision 4). Until it is made and recorded, nothing
-- deletes client data automatically, and the schema refuses to be switched on
-- without a duration.
--
-- Forward-only.

create table if not exists public.system_settings (
  id                      boolean primary key default true,

  retention_enabled       boolean not null default false,
  retention_dry_run_only  boolean not null default true,
  enquiry_retention_days  integer,
  client_retention_days   integer,
  file_retention_days     integer,
  activity_retention_days integer,

  retention_policy_version integer not null default 1,
  retention_decided_by    uuid references public.profiles(id) on delete set null,
  retention_decided_at    timestamptz,

  default_currency        text not null default 'GBP',

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint system_settings_singleton check (id),
  constraint system_settings_currency_iso check (default_currency ~ '^[A-Z]{3}$'),
  constraint system_settings_durations_positive check (
    coalesce(enquiry_retention_days, 1) > 0
    and coalesce(client_retention_days, 1) > 0
    and coalesce(file_retention_days, 1) > 0
    and coalesce(activity_retention_days, 1) > 0
  ),
  -- Retention cannot be enabled without at least one duration and a recorded
  -- owner decision. This is what stops "enabled" from silently meaning
  -- "delete immediately" or "delete never".
  constraint system_settings_enable_requires_policy check (
    retention_enabled = false
    or (
      num_nonnulls(enquiry_retention_days, client_retention_days, file_retention_days, activity_retention_days) > 0
      and retention_decided_by is not null
      and retention_decided_at is not null
    )
  )
);

insert into public.system_settings (id) values (true) on conflict (id) do nothing;

comment on table public.system_settings is
  'Single-row owner-only settings. Retention ships disabled with null durations; no duration is invented by a migration.';
comment on column public.system_settings.retention_dry_run_only is
  'While true, a retention job may only report what it would delete. It must stay true until a dry run has been reviewed.';

-- ---------------------------------------------------------------------------
-- Legal and operational holds
--
-- A hold outranks any retention duration. A future deletion job must skip an
-- entity with an active hold, whatever the policy says.
-- ---------------------------------------------------------------------------

create table if not exists public.retention_holds (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients(id) on delete cascade,
  enquiry_id  uuid references public.enquiries(id) on delete cascade,
  project_id  uuid references public.projects(id) on delete cascade,
  reason_code text not null,
  placed_by   uuid references public.profiles(id) on delete set null,
  placed_at   timestamptz not null default now(),
  released_at timestamptz,

  constraint retention_holds_has_entity check (num_nonnulls(client_id, enquiry_id, project_id) >= 1),
  constraint retention_holds_reason_shape check (reason_code ~ '^[a-z][a-z0-9_]{2,63}$')
);

create index if not exists retention_holds_active_idx
  on public.retention_holds (client_id, enquiry_id, project_id) where released_at is null;

-- ---------------------------------------------------------------------------
-- RLS: owner only, both tables
-- ---------------------------------------------------------------------------

alter table public.system_settings enable row level security;
alter table public.system_settings force row level security;
alter table public.retention_holds enable row level security;
alter table public.retention_holds force row level security;

revoke all on public.system_settings from anon, authenticated, service_role;
revoke all on public.retention_holds from anon, authenticated, service_role;
grant select on public.system_settings to authenticated;
grant select on public.retention_holds to authenticated;

drop policy if exists system_settings_select_owner on public.system_settings;
create policy system_settings_select_owner on public.system_settings
  for select using (public.is_owner() or crm_private.is_service_backend());

drop policy if exists system_settings_update_owner on public.system_settings;
create policy system_settings_update_owner on public.system_settings
  for update
  using (public.is_owner() or crm_private.is_service_backend())
  with check (public.is_owner() or crm_private.is_service_backend());

drop policy if exists retention_holds_select_owner on public.retention_holds;
create policy retention_holds_select_owner on public.retention_holds
  for select using (public.is_owner() or crm_private.is_service_backend());

drop policy if exists retention_holds_insert_owner on public.retention_holds;
create policy retention_holds_insert_owner on public.retention_holds
  for insert with check (public.is_owner() or crm_private.is_service_backend());

drop policy if exists retention_holds_update_owner on public.retention_holds;
create policy retention_holds_update_owner on public.retention_holds
  for update
  using (public.is_owner() or crm_private.is_service_backend())
  with check (public.is_owner() or crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- Owner-only settings RPC
-- ---------------------------------------------------------------------------

create or replace function public.update_retention_policy(
  p_enabled                 boolean,
  p_enquiry_retention_days  integer default null,
  p_client_retention_days   integer default null,
  p_file_retention_days     integer default null,
  p_activity_retention_days integer default null,
  p_dry_run_only            boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_role('owner');

  if p_enabled and num_nonnulls(
       p_enquiry_retention_days, p_client_retention_days,
       p_file_retention_days, p_activity_retention_days
     ) = 0 then
    raise exception 'retention cannot be enabled without at least one duration'
      using errcode = '22023',
            hint = 'Record an explicit owner decision; a duration is never assumed.';
  end if;

  update public.system_settings s
  set retention_enabled = p_enabled,
      retention_dry_run_only = p_dry_run_only,
      enquiry_retention_days = p_enquiry_retention_days,
      client_retention_days = p_client_retention_days,
      file_retention_days = p_file_retention_days,
      activity_retention_days = p_activity_retention_days,
      retention_policy_version = s.retention_policy_version + 1,
      retention_decided_by = auth.uid(),
      retention_decided_at = now()
  where s.id;

  perform crm_private.log_activity(
    'settings.retention_updated', 'owner', auth.uid(),
    null, null, null, null, null, null, null, null,
    jsonb_build_object('enabled', p_enabled, 'dry_run_only', p_dry_run_only)
  );

  return jsonb_build_object('retention_enabled', p_enabled, 'dry_run_only', p_dry_run_only);
end;
$$;

revoke all on function public.update_retention_policy(boolean, integer, integer, integer, integer, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.update_retention_policy(boolean, integer, integer, integer, integer, boolean) to authenticated;

-- No scheduled deletion job is created by this migration, and none may be
-- created while `retention_enabled` is false. A future job must support a dry
-- run, write audit events, honour `retention_holds`, and clean the database and
-- Storage in separate, individually auditable passes.

-- ---------------------------------------------------------------------------
-- Final privilege sweep
--
-- Migrations 0008-0010 create functions after migration 0007's revoke ran, and
-- PostgreSQL grants EXECUTE to PUBLIC by default. Sweeping again here means a
-- function added to a later migration cannot silently become an anonymous RPC
-- endpoint through PostgREST.
-- ---------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all tables in schema public from anon;
