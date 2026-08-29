-- 0118_deposit_requirement_semantics.sql
--
-- New projects start with no deposit request rather than an implicit waiver.
-- A dedicated, audited RPC is the only UI path for explicitly waiving or
-- restoring the requirement before money/request history exists.

alter table public.projects
  alter column deposit_status set default 'not_requested'::public.deposit_status;

comment on column public.projects.deposit_status is
  'Deposit lifecycle. not_requested is the default before a request exists; not_required is an explicit business decision.';

create or replace function public.set_project_deposit_requirement(
  p_project_id uuid,
  p_required boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_next public.deposit_status;
begin
  if p_required is null then
    raise exception 'deposit requirement must be explicit' using errcode = '22023';
  end if;

  select p.* into v_project
  from public.projects p
  where p.id = p_project_id
    and p.archived_at is null
  for update;

  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'manage_finance');

  if v_project.deposit_status not in ('not_requested', 'not_required') then
    raise exception 'deposit requirement cannot be changed after a request or payment lifecycle has started'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.payment_requests r
    where r.project_id = p_project_id
      and r.purpose = 'deposit'
      and r.status in ('pending', 'partially_paid', 'paid')
  ) then
    raise exception 'deposit requirement cannot be changed while a deposit request is active or paid'
      using errcode = '22023';
  end if;

  v_next := case when p_required then 'not_requested'::public.deposit_status
                 else 'not_required'::public.deposit_status end;

  update public.projects p
  set deposit_status = v_next,
      deposit_amount = case when p_required then p.deposit_amount else null end
  where p.id = p_project_id;

  perform crm_private.log_artist_activity(
    v_project.artist_id,
    'project.deposit_requirement_changed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_project.client_id,
    v_project.enquiry_id,
    p_project_id,
    null,
    null,
    jsonb_build_object(
      'from_status', v_project.deposit_status,
      'to_status', v_next,
      'required', p_required
    )
  );

  return jsonb_build_object(
    'project_id', p_project_id,
    'deposit_status', v_next,
    'required', p_required
  );
end;
$$;

revoke all on function public.set_project_deposit_requirement(uuid,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_project_deposit_requirement(uuid,boolean)
  to authenticated;
