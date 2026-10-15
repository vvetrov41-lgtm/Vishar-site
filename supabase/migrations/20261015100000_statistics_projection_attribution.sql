-- Statistics projections: the columns the corrected Statistics definitions need.
--
-- Audit of 2026-10-15 (docs/audits/2026-10-15-vishar-crm-statistics-audit.md
-- on the website branch) found that the Statistics screen could not tell paid
-- campaign traffic from any other website enquiry, could not count tattoo
-- bookings by the day they were made, and could not tell an open payment
-- request from an expired one, because the projections below never carried
-- those columns.
--
-- This migration only appends columns to the existing projections. It does
-- not change any row filter, the analytics exclusion lineage, a grant, a
-- policy or a base table:
-- * every view stays security_invoker, so row level security on the base
--   tables remains the only access boundary;
-- * every appended column is already readable by `authenticated` on its base
--   table (column privileges checked on production 2026-10-15), so a caller
--   gains nothing they could not already select;
-- * `referrer` is reduced to its host. The full referrer URL can carry click
--   identifiers and query strings that Statistics has no use for.
--
-- `create or replace view` may only append columns, which is exactly what is
-- done: the existing column list and order are unchanged, so every current
-- reader (the CRM, gpt_get_statistics) keeps working.

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
  e.archived_at,
  e.utm_medium,
  e.utm_campaign,
  nullif(lower(substring(e.referrer from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#@]+)')), '') as referrer_host
from public.enquiries e
where e.excluded_from_analytics = false;

comment on view public.statistics_enquiries is
  'RLS-preserving Statistics projection. Explicitly excluded enquiries are absent before any browser aggregation. referrer_host is the referrer host only, never the full URL.';

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
  s.cancelled_at,
  s.created_at
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
  'RLS-preserving Statistics projection. Sessions are excluded when either their direct enquiry or project enquiry lineage is excluded. created_at is when the booking was made.';

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
  r.created_at,
  r.expires_at
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

-- create or replace keeps the existing grants; restated so the boundary is
-- legible in this file and survives any future drop/recreate.
revoke all on table
  public.statistics_enquiries,
  public.statistics_sessions,
  public.statistics_payment_requests
from public, anon;

grant select on table
  public.statistics_enquiries,
  public.statistics_sessions,
  public.statistics_payment_requests
to authenticated;
