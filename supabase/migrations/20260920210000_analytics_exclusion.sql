-- Exclude explicitly marked test/internal enquiries from every Statistics metric.
--
-- The marker lives on the enquiry because that is the acquisition event the
-- statistics cohort starts from. The statistics views carry the exclusion
-- through linked projects, sessions and finance without deleting CRM history.
--
-- Security:
-- * public booking input cannot set this column;
-- * authenticated users still have no direct UPDATE privilege on enquiries;
-- * the only browser write path is the narrow artist-authorized RPC below;
-- * all statistics views are security_invoker so existing RLS remains
--   authoritative.

alter table public.enquiries
  add column if not exists excluded_from_analytics boolean not null default false;

comment on column public.enquiries.excluded_from_analytics is
  'Explicit operator/system marker. True keeps the enquiry and its linked work in CRM but excludes that lineage from Statistics. Never inferred from client name.';

-- security_invoker joins need the caller to be allowed to inspect the marker;
-- this is read-only metadata and does not expose customer content.
grant select (excluded_from_analytics) on public.enquiries to authenticated;

create or replace view public.statistics_enquiries
with (security_invoker = true)
as
select
  e.id,
  e.artist_id,
  e.client_id,
  e.status,
  e.intake_state,
  e.source,
  e.booking_source_id,
  e.communication_channel,
  e.utm_source,
  e.discovery_source,
  e.created_at,
  e.archived_at
from public.enquiries e
where e.excluded_from_analytics = false;

comment on view public.statistics_enquiries is
  'RLS-preserving Statistics projection. Explicitly excluded enquiries are absent before any browser aggregation.';

create or replace view public.statistics_projects
with (security_invoker = true)
as
select
  p.id,
  p.artist_id,
  p.client_id,
  p.enquiry_id,
  p.status,
  p.created_at,
  p.archived_at
from public.projects p
where p.enquiry_id is null
   or exists (
     select 1
     from public.enquiries e
     where e.id = p.enquiry_id
       and e.excluded_from_analytics = false
   );

comment on view public.statistics_projects is
  'RLS-preserving Statistics projection. Projects linked to excluded enquiries are absent.';

create or replace view public.statistics_sessions
with (security_invoker = true)
as
select
  s.id,
  s.artist_id,
  s.client_id,
  s.project_id,
  s.enquiry_id,
  s.status,
  s.appointment_type,
  s.start_at,
  s.end_at,
  s.duration_hours,
  s.cancelled_at
from public.sessions s
where (
    s.enquiry_id is null
    or exists (
      select 1
      from public.enquiries direct_e
      where direct_e.id = s.enquiry_id
        and direct_e.excluded_from_analytics = false
    )
  )
  and (
    s.project_id is null
    or exists (
      select 1
      from public.projects p
      where p.id = s.project_id
        and (
          p.enquiry_id is null
          or exists (
            select 1
            from public.enquiries project_e
            where project_e.id = p.enquiry_id
              and project_e.excluded_from_analytics = false
          )
        )
    )
  );

comment on view public.statistics_sessions is
  'RLS-preserving Statistics projection. Sessions are excluded when either their direct enquiry or project enquiry lineage is excluded.';

create or replace view public.statistics_payment_requests
with (security_invoker = true)
as
select
  r.id,
  r.artist_id,
  r.project_id,
  r.session_id,
  r.purpose,
  r.amount,
  r.currency,
  r.status,
  r.created_at
from public.payment_requests r
where (
    r.project_id is null
    or exists (
      select 1
      from public.statistics_projects p
      where p.id = r.project_id
    )
  )
  and (
    r.session_id is null
    or exists (
      select 1
      from public.statistics_sessions s
      where s.id = r.session_id
    )
  );

comment on view public.statistics_payment_requests is
  'RLS-preserving Statistics projection. Payment requests inherit project/session analytics exclusion.';

create or replace view public.statistics_payment_transactions
with (security_invoker = true)
as
select
  t.id,
  t.artist_id,
  t.transaction_type,
  t.direction,
  t.amount,
  t.currency,
  t.status,
  t.occurred_at
from public.payment_transactions t
where t.payment_request_id is null
   or exists (
     select 1
     from public.statistics_payment_requests r
     where r.id = t.payment_request_id
   );

comment on view public.statistics_payment_transactions is
  'RLS-preserving Statistics projection. Transactions linked to an excluded payment request lineage are absent; historical unlinked transactions remain countable.';

revoke all on table
  public.statistics_enquiries,
  public.statistics_projects,
  public.statistics_sessions,
  public.statistics_payment_requests,
  public.statistics_payment_transactions
from public, anon;

grant select on table
  public.statistics_enquiries,
  public.statistics_projects,
  public.statistics_sessions,
  public.statistics_payment_requests,
  public.statistics_payment_transactions
to authenticated;

create or replace function public.set_enquiry_analytics_exclusion(
  p_enquiry_id uuid,
  p_excluded boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_actor_kind text;
begin
  if p_enquiry_id is null or p_excluded is null then
    raise exception 'enquiry id and exclusion state are required'
      using errcode = '22023';
  end if;

  select e.*
    into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id
  for update;

  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if v_enquiry.excluded_from_analytics = p_excluded then
    return jsonb_build_object(
      'enquiry_id', p_enquiry_id,
      'excluded_from_analytics', p_excluded,
      'changed', false
    );
  end if;

  update public.enquiries
  set excluded_from_analytics = p_excluded
  where id = p_enquiry_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  perform crm_private.log_artist_activity(
    v_enquiry.artist_id,
    'enquiry.analytics_exclusion_changed',
    v_actor_kind,
    auth.uid(),
    v_enquiry.client_id,
    v_enquiry.id,
    null,
    null,
    null,
    jsonb_build_object('excluded', p_excluded)
  );

  return jsonb_build_object(
    'enquiry_id', p_enquiry_id,
    'excluded_from_analytics', p_excluded,
    'changed', true
  );
end;
$$;

revoke all on function public.set_enquiry_analytics_exclusion(uuid,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_enquiry_analytics_exclusion(uuid,boolean)
  to authenticated;

comment on function public.set_enquiry_analytics_exclusion(uuid,boolean) is
  'Narrow artist-authorized switch for Statistics inclusion. Preserves the enquiry and all linked CRM history; only Statistics projections change.';
