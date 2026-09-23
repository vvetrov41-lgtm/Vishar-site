-- Audit L-3 (Vishar CRM audit 2026-09-22): record the owner's retention decision.
--
-- 0010 shipped retention disabled with every duration NULL and left the choice
-- to the owner. The owner has now decided: an enquiry, and the reference files
-- uploaded with it, that never became a project is kept for 5 years (1825
-- days) after its last activity. Clients, projects, sessions, payments and the
-- activity history are not covered and stay NULL.
--
-- The existing columns hold a duration but not what it applies to, so the
-- scope is recorded explicitly beside it. A future deletion job must read both
-- and must never apply `enquiry_retention_days` to an enquiry with a project.
--
-- `retention_enabled` stays false and `retention_dry_run_only` stays true on
-- purpose. No retention executor exists in this repository (0010 created none
-- and none has been added), so "enabled" would promise a deletion that nothing
-- performs. Turning it on belongs with that executor, which must dry-run,
-- honour `retention_holds`, audit, and clean database and Storage separately.
-- At the time of this decision no enquiry is anywhere near the threshold: the
-- oldest last activity of a never-converted enquiry is August 2026.

alter table public.system_settings
  add column if not exists enquiry_retention_scope text;

alter table public.system_settings
  drop constraint if exists system_settings_enquiry_retention_scope_known;
alter table public.system_settings
  add constraint system_settings_enquiry_retention_scope_known check (
    enquiry_retention_scope is null
    or enquiry_retention_scope = 'never_converted_after_last_activity'
  );

comment on column public.system_settings.enquiry_retention_scope is
  'What enquiry_retention_days and file_retention_days apply to. never_converted_after_last_activity: enquiries with no project, and their reference files, counted from the enquiry''s last activity.';

update public.system_settings s
set enquiry_retention_days = 1825,
    file_retention_days = 1825,
    enquiry_retention_scope = 'never_converted_after_last_activity',
    retention_policy_version = s.retention_policy_version + 1,
    retention_decided_by = (
      select p.id from public.profiles p
      where p.role = 'owner' and p.is_active
      order by p.created_at, p.id
      limit 1
    ),
    retention_decided_at = now()
where s.id
  and s.enquiry_retention_days is null
  and s.file_retention_days is null
  and not s.retention_enabled;

do $$
begin
  if exists (
    select 1 from public.system_settings s
    where s.enquiry_retention_scope = 'never_converted_after_last_activity'
      and s.enquiry_retention_days = 1825
      and s.file_retention_days = 1825
      and not s.retention_enabled
  ) and not exists (
    select 1 from public.activity_log l
    where l.event_type = 'settings.retention_updated'
      and l.metadata ->> 'decision' = 'audit_l3_owner_decision'
  ) then
    perform crm_private.log_activity(
      'settings.retention_updated', 'system', null,
      null, null, null, null, null, null, null, null,
      jsonb_build_object(
        'enabled', false,
        'dry_run_only', true,
        'enquiry_retention_days', 1825,
        'file_retention_days', 1825,
        'scope', 'never_converted_after_last_activity',
        'decision', 'audit_l3_owner_decision'
      )
    );
  end if;
end;
$$;
