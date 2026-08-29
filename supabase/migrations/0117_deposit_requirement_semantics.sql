-- 0117_deposit_requirement_semantics.sql
--
-- Preserve the existing deposit_status enum and legacy transfer/API contracts
-- while distinguishing two pre-request states:
--   not_required + deposit_amount IS NULL -> no project deposit requested yet
--   not_required + deposit_amount = 0      -> explicit business waiver
-- Once a project-level request is created, the authoritative payment ledger
-- advances the project to requested/paid automatically.

comment on column public.projects.deposit_status is
  'Project deposit lifecycle. Before the first request, not_required with NULL deposit_amount means not requested yet; not_required with zero deposit_amount is an explicit waiver.';

create or replace function crm_private.guard_project_deposit_waiver()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.purpose = 'deposit'
     and new.project_id is not null
     and new.session_id is null
     and exists (
       select 1
       from public.projects p
       where p.id = new.project_id
         and p.deposit_status = 'not_required'
         and p.deposit_amount = 0
     ) then
    raise exception 'this project is explicitly marked as not requiring a deposit; mark the deposit as required before creating a request'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.guard_project_deposit_waiver()
  from public, anon, authenticated, service_role;

create or replace function crm_private.sync_project_deposit_from_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.purpose <> 'deposit'
     or new.project_id is null
     or new.session_id is not null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    update public.projects p
    set deposit_status = case
          when new.status = 'paid' then 'paid'::public.deposit_status
          else 'requested'::public.deposit_status
        end,
        deposit_amount = new.amount
    where p.id = new.project_id
      and p.deposit_status in ('not_required', 'requested');
  elsif new.status is distinct from old.status and new.status = 'paid' then
    update public.projects p
    set deposit_status = 'paid'::public.deposit_status,
        deposit_amount = new.amount
    where p.id = new.project_id
      and p.deposit_status <> 'paid';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.sync_project_deposit_from_request()
  from public, anon, authenticated, service_role;

drop trigger if exists payment_requests_guard_project_deposit_waiver
  on public.payment_requests;
create trigger payment_requests_guard_project_deposit_waiver
before insert on public.payment_requests
for each row execute function crm_private.guard_project_deposit_waiver();

drop trigger if exists payment_requests_sync_project_deposit
  on public.payment_requests;
create trigger payment_requests_sync_project_deposit
after insert or update of status on public.payment_requests
for each row execute function crm_private.sync_project_deposit_from_request();
