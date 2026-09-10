-- 20260910200000_crm_agent_canonical_facts.sql
--
-- Refresh the derived state when the CRM facts it is measured against change.
--
-- THE GAP THIS CLOSES
--
-- The watermark already covered projects and sessions, so a confirmed booking
-- correctly made an old brief report itself stale. Nothing scheduled the
-- recomputation, though: scheduling was wired to enquiries, communications,
-- conversation links, enquiry files and Gmail. A deposit paid through the real
-- payment flow left `request_deposit` sitting open as the artist's next step,
-- correct at the moment it was written and wrong by the time they read it.
--
-- Deposits and payments do not need their own trigger. `payment_requests`
-- already projects onto `projects.deposit_status` and `deposit_amount` through
-- `crm_private.sync_project_deposit_from_request` (0117), and session payment
-- lands on `sessions.payment_status`. Triggering on the projection rather than
-- on every payment row keeps one refresh per material change instead of one
-- per webhook, and means a future payment provider inherits this for free.
--
-- WHAT COUNTS AS MATERIAL
--
-- Only the columns the brief is actually allowed to reason about, listed once
-- in the digest below. A note edited on a project, a calendar version bumped
-- by a sync, or an UPDATE that writes the same values back are all no-ops:
-- `UPDATE OF` narrows which statements fire the trigger at all, and the
-- IS DISTINCT FROM digest test drops the rest before anything is queued.

create function crm_private.project_ai_fingerprint(p public.projects)
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select left(encode(extensions.digest(convert_to(
    coalesce(p.status::text, '') || '|' ||
    coalesce(p.deposit_status::text, '') || '|' ||
    coalesce(p.deposit_amount::text, '') || '|' ||
    coalesce(p.estimate_total::text, '') || '|' ||
    coalesce(p.estimated_sessions::text, '') || '|' ||
    coalesce(p.estimated_hours::text, '') || '|' ||
    coalesce(p.hourly_rate::text, '') || '|' ||
    coalesce(p.currency, '') || '|' ||
    coalesce(p.archived_at::text, ''), 'UTF8'), 'sha256'), 'hex'), 16);
$$;

create function crm_private.session_ai_fingerprint(s public.sessions)
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select left(encode(extensions.digest(convert_to(
    coalesce(s.status::text, '') || '|' ||
    coalesce(s.start_at::text, '') || '|' ||
    coalesce(s.end_at::text, '') || '|' ||
    coalesce(s.payment_status::text, '') || '|' ||
    coalesce(s.price::text, '') || '|' ||
    coalesce(s.cancelled_at::text, ''), 'UTF8'), 'sha256'), 'hex'), 16);
$$;

revoke all on function
  crm_private.project_ai_fingerprint(public.projects),
  crm_private.session_ai_fingerprint(public.sessions)
  from public, anon, authenticated, service_role;

comment on function crm_private.project_ai_fingerprint(public.projects) is
  'Digest of the project columns the client brief may reason about. Two writes with the same values produce the same fingerprint, so a no-op UPDATE queues nothing.';

-- The fingerprint is also the event identity, so several rapid changes to the
-- same values collapse to one job while a genuine change gets its own. It
-- carries an id and a hash and no personal data.
create function crm_private.enqueue_project_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_new text;
begin
  v_new := crm_private.project_ai_fingerprint(new);
  if tg_op = 'UPDATE' and crm_private.project_ai_fingerprint(old) = v_new then
    return new;
  end if;
  -- A payment webhook must not fail because the AI queue is unavailable, and
  -- neither must an artist saving an estimate. No SQLERRM is emitted: it can
  -- carry a client identifier from a constraint message.
  begin
    perform crm_private.schedule_client_ai_refresh(
      new.artist_id, new.client_id, 'project:' || new.id::text || ':' || v_new);
  exception when others then null;
  end;
  return new;
end;
$$;

create function crm_private.enqueue_session_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_new text;
begin
  if new.client_id is null then
    return new;
  end if;
  v_new := crm_private.session_ai_fingerprint(new);
  if tg_op = 'UPDATE' and crm_private.session_ai_fingerprint(old) = v_new then
    return new;
  end if;
  begin
    perform crm_private.schedule_client_ai_refresh(
      new.artist_id, new.client_id, 'session:' || new.id::text || ':' || v_new);
  exception when others then null;
  end;
  return new;
end;
$$;

revoke all on function
  crm_private.enqueue_project_client_ai(),
  crm_private.enqueue_session_client_ai()
  from public, anon, authenticated, service_role;

create trigger projects_enqueue_client_ai
  after insert or update of
    status, deposit_status, deposit_amount, estimate_total,
    estimated_sessions, estimated_hours, hourly_rate, currency, archived_at
  on public.projects
  for each row execute function crm_private.enqueue_project_client_ai();

create trigger sessions_enqueue_client_ai
  after insert or update of
    status, start_at, end_at, payment_status, price, cancelled_at
  on public.sessions
  for each row execute function crm_private.enqueue_session_client_ai();

comment on function crm_private.enqueue_project_client_ai() is
  'Schedules a client-state refresh when a material project fact changes, including the deposit state that payment_requests projects onto this table. Idempotent per fingerprint and non-blocking.';
