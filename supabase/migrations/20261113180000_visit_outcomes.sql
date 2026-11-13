-- Visit outcomes: the artist confirms what actually happened at a tattoo
-- session or a consultation, from a Today card.
--
-- sessions.status stays the scheduling/lifecycle state. A scheduled automatic
-- completion (crm_private.auto_complete_due_tattoo_sessions) proves only that
-- the booked time passed. The confirmed facts live here:
--
-- * public.visit_outcomes            one row per appointment (current state)
-- * public.visit_outcome_revisions   append-only history, keyed by the
--                                    caller's operation id (idempotency)
--
-- Money is never stored as a second ledger. A new receipt is recorded through
-- the existing invoice mechanism (create_invoice / set_invoice_line_item /
-- issue_invoice / record_invoice_payment) inside the same transaction, keyed
-- by ids derived from the operation id, so a retry cannot create a second
-- invoice or payment. A previously paid deposit and earlier receipts are read
-- from the ledger and never recorded again.
--
-- Client messages: this migration creates no automation rule, event type or
-- outbox kind. Outcome activity uses the event type 'visit.outcome_recorded',
-- which is not in public.automation_trigger_catalog. Status changes reuse the
-- transitions the scheduler already understands: completed keeps the existing
-- aftercare/check-in rules; no_show/cancelled make the scheduler cancel
-- pending post-session jobs (service_run_automation_tick). A cancelled job is
-- never revived, so a later correction cannot replay aftercare.
--
-- Rollout: Today shows cards only for visits that end after
-- crm_private.visit_outcome_rollout.enabled_from (set to the apply time).
-- Older visits stay available for voluntary review from the appointment.

-- ---------------------------------------------------------------------------
-- Rollout switch
-- ---------------------------------------------------------------------------

create table crm_private.visit_outcome_rollout (
  singleton boolean primary key default true check (singleton),
  enabled_from timestamptz,
  updated_at timestamptz not null default now()
);

insert into crm_private.visit_outcome_rollout (singleton, enabled_from)
values (true, now());

revoke all on table crm_private.visit_outcome_rollout from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Current outcome per appointment
-- ---------------------------------------------------------------------------

create table public.visit_outcomes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.sessions(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_type public.appointment_type not null,
  state text not null check (state in ('deferred', 'confirmed')),
  outcome text check (outcome in (
    'attended', 'no_show', 'cancelled',
    'booked', 'ready_to_book', 'thinking', 'declined')),
  work_result text check (work_result in ('work_complete', 'next_session_needed', 'touch_up_needed')),
  worked_minutes integer check (worked_minutes between 1 and 1440),
  final_price numeric(12,2) check (final_price > 0 and final_price <= 100000),
  currency text check (currency ~ '^[A-Z]{3}$'),
  deposit_applied numeric(12,2) check (deposit_applied >= 0),
  previously_received numeric(12,2) check (previously_received >= 0),
  received_via_outcome numeric(12,2) not null default 0 check (received_via_outcome >= 0),
  outstanding numeric(12,2) check (outstanding >= 0),
  payment_state text check (payment_state in ('paid', 'part_paid', 'unpaid', 'needs_review', 'not_recorded')),
  payment_method text check (payment_method in ('cash', 'bank_transfer', 'card', 'other')),
  paid_outside_crm boolean not null default false,
  linked_session_id uuid references public.sessions(id) on delete set null,
  follow_up_id uuid references public.follow_ups(id) on delete set null,
  enquiry_status_after public.enquiry_status,
  notes text check (notes is null or char_length(notes) <= 2000),
  aftercare_sent_before_outcome boolean,
  deferred_until timestamptz,
  version integer not null default 1 check (version >= 1),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint visit_outcomes_state_shape check (
    (state = 'deferred' and outcome is null and deferred_until is not null)
    or (state = 'confirmed' and outcome is not null and confirmed_at is not null)
  ),
  constraint visit_outcomes_type_outcome check (
    outcome is null
    or (appointment_type in ('tattoo_session', 'touch_up')
        and outcome in ('attended', 'no_show', 'cancelled'))
    or (appointment_type in ('in_person_consultation', 'video_consultation')
        and outcome in ('booked', 'ready_to_book', 'thinking', 'declined', 'no_show'))
  ),
  -- Consultations are free: no price, receipt or tattoo payment fields.
  constraint visit_outcomes_consultation_free check (
    appointment_type in ('tattoo_session', 'touch_up')
    or (final_price is null and deposit_applied is null and previously_received is null
        and received_via_outcome = 0 and outstanding is null and payment_method is null
        and payment_state is null and not paid_outside_crm and work_result is null
        and worked_minutes is null)
  ),
  constraint visit_outcomes_booking_link check (
    outcome is distinct from 'booked' or linked_session_id is not null
  )
);

create index visit_outcomes_artist_idx on public.visit_outcomes (artist_id, state);
create index visit_outcomes_client_idx on public.visit_outcomes (client_id);

alter table public.visit_outcomes enable row level security;
alter table public.visit_outcomes force row level security;

-- Reads and writes go through the RPCs below, which apply per-artist session
-- and finance capabilities. No direct table access for browser roles.
create policy visit_outcomes_service_only on public.visit_outcomes
  for all using (crm_private.is_service_backend())
  with check (crm_private.is_service_backend());

revoke all on table public.visit_outcomes from public, anon, authenticated;

create trigger visit_outcomes_set_updated_at
  before update on public.visit_outcomes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Append-only history (idempotency + audit trail)
-- ---------------------------------------------------------------------------

create table public.visit_outcome_revisions (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  outcome_id uuid not null references public.visit_outcomes(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  version integer not null,
  action text not null check (action in ('defer', 'confirm', 'correct')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{32}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  effects jsonb not null default '{}'::jsonb check (jsonb_typeof(effects) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (outcome_id, version)
);

create index visit_outcome_revisions_session_idx on public.visit_outcome_revisions (session_id, version);

alter table public.visit_outcome_revisions enable row level security;
alter table public.visit_outcome_revisions force row level security;
create policy visit_outcome_revisions_service_only on public.visit_outcome_revisions
  for all using (crm_private.is_service_backend())
  with check (crm_private.is_service_backend());
revoke all on table public.visit_outcome_revisions from public, anon, authenticated;

create function crm_private.reject_visit_outcome_revision_mutation()
returns trigger language plpgsql
set search_path = pg_catalog as $fn$
begin
  raise exception 'visit outcome history is append-only' using errcode = '42501';
end;
$fn$;
revoke all on function crm_private.reject_visit_outcome_revision_mutation()
  from public, anon, authenticated, service_role;

create trigger visit_outcome_revisions_append_only
  before update or delete on public.visit_outcome_revisions
  for each row execute function crm_private.reject_visit_outcome_revision_mutation();
create trigger visit_outcome_revisions_append_only_truncate
  before truncate on public.visit_outcome_revisions
  for each statement execute function crm_private.reject_visit_outcome_revision_mutation();

-- ---------------------------------------------------------------------------
-- Ledger-backed money position of one tattoo session.
-- Mirrors admin/src/lib/session-checkout.ts: every credit must be explicitly
-- attributable to this session; anything ambiguous blocks a new receipt.
-- sessions.payment_status is never used to compute money.
-- ---------------------------------------------------------------------------

create function crm_private.visit_session_finance(p_session_id uuid, p_price numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_project public.projects%rowtype;
  v_price numeric;
  v_warnings text[] := '{}';
  v_deposit numeric := 0;
  v_invoiced numeric := 0;
  v_due numeric;
  v_session_invoices uuid[];
  v_payable uuid;
  v_payable_outstanding numeric;
  v_payable_status public.invoice_status;
begin
  select * into v_session from public.sessions where id = p_session_id;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  v_price := coalesce(p_price, v_session.price);
  if v_session.project_id is not null then
    select * into v_project from public.projects where id = v_session.project_id;
  end if;

  -- Deposits: currency and allocation checks (project scope).
  if exists (
    select 1 from public.payment_requests r
    where r.project_id = v_session.project_id and r.purpose = 'deposit'
      and (r.session_id = v_session.id or r.session_id is null)
      and r.currency <> v_session.currency
      and crm_private.visit_request_net_paid(r.id) > 0
  ) then v_warnings := v_warnings || 'currency_mismatch'; end if;
  if exists (
    select 1 from public.payment_requests r
    where r.project_id = v_session.project_id and r.purpose = 'deposit'
      and r.session_id is null and crm_private.visit_request_net_paid(r.id) > 0
  ) then v_warnings := v_warnings || 'unallocated_deposit'; end if;
  -- A legacy paid project deposit without a ledger request cannot be allocated.
  if v_project.id is not null and v_project.deposit_status = 'paid'
     and coalesce(v_project.deposit_amount, 0) > 0
     and not exists (
       select 1 from public.payment_requests r
       where r.project_id = v_project.id and r.purpose = 'deposit'
         and crm_private.visit_request_net_paid(r.id) > 0)
  then v_warnings := v_warnings || 'unallocated_deposit'; end if;

  -- Invoices of this project.
  if exists (
    select 1 from public.invoices i
    where i.project_id = v_session.project_id and i.status <> 'void'
      and (not exists (select 1 from public.invoice_line_items li where li.invoice_id = i.id)
           or exists (select 1 from public.invoice_line_items li
                      where li.invoice_id = i.id and li.session_id is null))
  ) then v_warnings := v_warnings || 'unlinked_invoice'; end if;

  select coalesce(array_agg(i.id order by i.created_at, i.id), '{}') into v_session_invoices
  from public.invoices i
  where i.project_id = v_session.project_id and i.status <> 'void'
    and exists (select 1 from public.invoice_line_items li
                where li.invoice_id = i.id and li.session_id = v_session.id);

  if exists (select 1 from public.invoices i where i.id = any(v_session_invoices)
             and i.currency <> v_session.currency)
  then v_warnings := v_warnings || 'currency_mismatch'; end if;
  if exists (select 1 from public.invoices i
             cross join lateral crm_private.invoice_totals(i.id) t
             where i.id = any(v_session_invoices)
               and (coalesce(t.amount_credited, 0) > 0 or coalesce(i.discount_amount, 0) > 0))
  then v_warnings := v_warnings || 'credited_invoice'; end if;
  if exists (select 1 from public.invoice_line_items li
             where li.invoice_id = any(v_session_invoices)
               and li.session_id is distinct from v_session.id)
  then v_warnings := v_warnings || 'mixed_invoice'; end if;

  select coalesce(sum(crm_private.visit_request_net_paid(r.id)), 0) into v_deposit
  from public.payment_requests r
  where r.session_id = v_session.id and r.purpose = 'deposit'
    and r.currency = v_session.currency
    and (r.invoice_id is null or not (r.invoice_id = any(v_session_invoices)));

  select coalesce(sum(t.amount_paid), 0) into v_invoiced
  from public.invoices i
  cross join lateral crm_private.invoice_totals(i.id) t
  where i.id = any(v_session_invoices) and i.currency = v_session.currency
    and not exists (select 1 from public.invoice_line_items li
                    where li.invoice_id = i.id and li.session_id is distinct from v_session.id);

  v_deposit := round(v_deposit, 2);
  v_invoiced := round(v_invoiced, 2);
  if v_price is not null and v_price + 0.005 < v_deposit + v_invoiced then
    v_warnings := v_warnings || 'overpaid';
  end if;

  select coalesce(array_agg(distinct w order by w), '{}') into v_warnings from unnest(v_warnings) w;

  if cardinality(v_warnings) = 0 and v_price is not null and v_price >= 0 then
    v_due := round(greatest(0, v_price - v_deposit - v_invoiced), 2);
  end if;

  if v_due is not null and v_due > 0 and cardinality(v_session_invoices) = 1 then
    select i.status, t.amount_outstanding into v_payable_status, v_payable_outstanding
    from public.invoices i cross join lateral crm_private.invoice_totals(i.id) t
    where i.id = v_session_invoices[1];
    if v_payable_status in ('issued', 'partially_paid')
       and abs(coalesce(v_payable_outstanding, -1) - v_due) < 0.005 then
      v_payable := v_session_invoices[1];
    end if;
  end if;

  return jsonb_build_object(
    'currency', v_session.currency,
    'price', v_price,
    'stored_price', v_session.price,
    'deposit_paid', v_deposit,
    'invoiced_paid', v_invoiced,
    'due', v_due,
    'warnings', to_jsonb(v_warnings),
    'session_invoice_count', cardinality(v_session_invoices),
    'payable_invoice_id', v_payable,
    'hourly_rate', v_project.hourly_rate,
    'project_currency', v_project.currency
  );
end;
$fn$;

create function crm_private.visit_request_net_paid(p_request_id uuid)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $fn$
  select coalesce(sum(case when t.direction = 'credit' then t.amount else -t.amount end), 0)
  from public.payment_transactions t
  where t.payment_request_id = p_request_id and t.status = 'succeeded';
$fn$;

revoke all on function crm_private.visit_request_net_paid(uuid) from public, anon, authenticated, service_role;
revoke all on function crm_private.visit_session_finance(uuid, numeric) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Which appointments need an outcome card in Today
-- ---------------------------------------------------------------------------

create function crm_private.visit_outcome_due(p_artist_id uuid, p_now timestamptz)
returns table (session_id uuid, client_id uuid, appointment_type public.appointment_type,
               status public.session_status, start_at timestamptz, end_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  select s.id, s.client_id, s.appointment_type, s.status, s.start_at, s.end_at
  from public.sessions s
  cross join crm_private.visit_outcome_rollout r
  where r.singleton and r.enabled_from is not null
    and s.artist_id = p_artist_id
    and s.cancelled_at is null
    and s.status in ('confirmed', 'completed')
    and s.end_at >= r.enabled_from
    -- A tattoo card is available once the client should have arrived, so a
    -- no-show can be recorded before the end-anchored aftercare is due. A
    -- consultation is asked about only after it has finished.
    and (
      (s.appointment_type in ('tattoo_session', 'touch_up')
       and s.start_at <= p_now - interval '30 minutes')
      or (s.appointment_type in ('in_person_consultation', 'video_consultation')
          and s.end_at <= p_now)
    )
    and not exists (
      select 1 from public.visit_outcomes o
      where o.session_id = s.id
        and (o.state = 'confirmed' or o.deferred_until > p_now)
    );
$fn$;
revoke all on function crm_private.visit_outcome_due(uuid, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Context for one card / appointment panel
-- ---------------------------------------------------------------------------

create function public.get_visit_outcome_context(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_outcome public.visit_outcomes%rowtype;
  v_view_finance boolean;
  v_is_tattoo boolean;
  v_outcome_json jsonb;
  v_bookings jsonb;
  v_enquiry_status public.enquiry_status;
  v_client_name text;
begin
  if p_session_id is null then
    raise exception 'an appointment id is required' using errcode = '22023';
  end if;
  select * into v_session from public.sessions where id = p_session_id;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_session.artist_id, 'view_sessions');

  v_view_finance := crm_private.has_artist_capability(v_session.artist_id, 'view_finance');
  v_is_tattoo := v_session.appointment_type in ('tattoo_session', 'touch_up');

  select * into v_outcome from public.visit_outcomes where session_id = v_session.id;
  if found then
    v_outcome_json := jsonb_build_object(
      'state', v_outcome.state, 'outcome', v_outcome.outcome,
      'work_result', v_outcome.work_result, 'worked_minutes', v_outcome.worked_minutes,
      'linked_session_id', v_outcome.linked_session_id, 'follow_up_id', v_outcome.follow_up_id,
      'enquiry_status_after', v_outcome.enquiry_status_after, 'notes', v_outcome.notes,
      'aftercare_sent_before_outcome', v_outcome.aftercare_sent_before_outcome,
      'deferred_until', v_outcome.deferred_until, 'version', v_outcome.version,
      'confirmed_at', v_outcome.confirmed_at, 'updated_at', v_outcome.updated_at
    ) || case when v_view_finance then jsonb_build_object(
      'final_price', v_outcome.final_price, 'currency', v_outcome.currency,
      'deposit_applied', v_outcome.deposit_applied,
      'previously_received', v_outcome.previously_received,
      'received_via_outcome', v_outcome.received_via_outcome,
      'outstanding', v_outcome.outstanding, 'payment_state', v_outcome.payment_state,
      'payment_method', v_outcome.payment_method, 'paid_outside_crm', v_outcome.paid_outside_crm
    ) else '{}'::jsonb end;
  end if;

  select left(btrim(c.full_name), 80) into v_client_name from public.clients c where c.id = v_session.client_id;
  if v_session.enquiry_id is not null then
    select e.status into v_enquiry_status from public.enquiries e where e.id = v_session.enquiry_id;
  end if;

  if not v_is_tattoo then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'appointment_type', b.appointment_type, 'status', b.status,
      'start_at', b.start_at, 'end_at', b.end_at, 'project_id', b.project_id
    ) order by b.start_at, b.id), '[]'::jsonb) into v_bookings
    from public.sessions b
    where b.artist_id = v_session.artist_id and b.client_id = v_session.client_id
      and b.id <> v_session.id
      and b.appointment_type in ('tattoo_session', 'touch_up')
      and b.cancelled_at is null
      and b.status in ('proposed', 'confirmed', 'completed')
      and b.start_at >= v_session.start_at - interval '1 day';
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id, 'artist_id', v_session.artist_id, 'client_id', v_session.client_id,
      'client_name', v_client_name, 'appointment_type', v_session.appointment_type,
      'status', v_session.status, 'start_at', v_session.start_at, 'end_at', v_session.end_at,
      'scheduled_minutes', round(extract(epoch from (v_session.end_at - v_session.start_at)) / 60),
      'project_id', v_session.project_id, 'enquiry_id', v_session.enquiry_id,
      'enquiry_status', v_enquiry_status, 'currency', v_session.currency
    ) || case when v_view_finance and v_is_tattoo
      then jsonb_build_object('payment_status', v_session.payment_status) else '{}'::jsonb end,
    'outcome', v_outcome_json,
    'version', coalesce(v_outcome.version, 0),
    'finance', case when v_view_finance and v_is_tattoo
      then crm_private.visit_session_finance(v_session.id) end,
    'bookings', v_bookings,
    'aftercare_sent', case when v_is_tattoo then exists (
      select 1 from public.automation_jobs j
      where j.session_id = v_session.id and j.message_purpose = 'post_session_aftercare'
        and j.status = 'completed') end,
    'can', jsonb_build_object(
      'record', crm_private.has_artist_capability(v_session.artist_id, 'manage_sessions'),
      'finance', crm_private.has_artist_capability(v_session.artist_id, 'manage_finance'),
      'follow_up', crm_private.has_artist_capability(v_session.artist_id, 'manage'),
      'view_finance', v_view_finance
    ),
    'needs_review', exists (select 1 from crm_private.visit_outcome_due(v_session.artist_id, clock_timestamp()) d
                            where d.session_id = v_session.id),
    'server_time', clock_timestamp()
  );
end;
$fn$;

revoke all on function public.get_visit_outcome_context(uuid) from public, anon;
grant execute on function public.get_visit_outcome_context(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Status transition used by an outcome (and its corrections)
-- ---------------------------------------------------------------------------

create function crm_private.apply_visit_status(
  p_session public.sessions,
  p_status public.session_status,
  p_actor_kind text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_version integer := p_session.calendar_version + 1;
begin
  if p_session.status = p_status then
    return false;
  end if;

  update public.sessions s
  set status = p_status,
      cancelled_at = case when p_status = 'cancelled' then now() else null end,
      calendar_version = v_version
  where s.id = p_session.id;

  perform crm_private.log_artist_activity(
    p_session.artist_id, 'appointment.status_changed', p_actor_kind, auth.uid(),
    p_session.client_id, p_session.enquiry_id, p_session.project_id, p_session.id, null,
    jsonb_build_object('appointment_type', p_session.appointment_type,
      'from_status', p_session.status, 'to_status', p_status,
      'completion_source', 'visit_outcome'));

  if public.session_is_calendar_eligible(p_status) and p_session.calendar_event_id is null then
    perform crm_private.enqueue_outbox('calendar_create',
      public.calendar_outbox_dedupe_key('create', p_session.id, v_version),
      jsonb_build_object('session_id', p_session.id, 'appointment_type', p_session.appointment_type,
        'calendar_version', v_version),
      p_session.client_id, p_session.enquiry_id, p_session.project_id, p_session.id, null);
  elsif p_status = 'cancelled' and p_session.calendar_event_id is not null then
    perform crm_private.enqueue_outbox('calendar_cancel',
      public.calendar_outbox_dedupe_key('cancel', p_session.id, v_version),
      jsonb_build_object('session_id', p_session.id, 'appointment_type', p_session.appointment_type,
        'calendar_version', v_version),
      p_session.client_id, p_session.enquiry_id, p_session.project_id, p_session.id, null);
  elsif public.session_is_calendar_eligible(p_status) and p_session.calendar_event_id is not null then
    perform crm_private.enqueue_outbox('calendar_update',
      public.calendar_outbox_dedupe_key('update', p_session.id, v_version),
      jsonb_build_object('session_id', p_session.id, 'appointment_type', p_session.appointment_type,
        'calendar_version', v_version),
      p_session.client_id, p_session.enquiry_id, p_session.project_id, p_session.id, null);
  end if;
  return true;
end;
$fn$;
revoke all on function crm_private.apply_visit_status(public.sessions, public.session_status, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Record (or correct) a confirmed outcome
-- ---------------------------------------------------------------------------

create function public.record_visit_outcome(
  p_session_id uuid,
  p_operation_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_details jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_outcome public.visit_outcomes%rowtype;
  v_has_outcome boolean;
  v_revision public.visit_outcome_revisions%rowtype;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
  v_hash text;
  v_now timestamptz := clock_timestamp();
  v_is_tattoo boolean;
  v_target public.session_status;
  v_actor_kind text;
  v_manage_finance boolean;
  v_correction boolean;
  v_status_changed boolean := false;
  v_minutes integer;
  v_price numeric;
  v_received numeric := 0;
  v_method text;
  v_outside boolean := false;
  v_work text;
  v_notes text;
  v_linked uuid;
  v_follow_at timestamptz;
  v_follow_up uuid;
  v_existing_follow_up uuid;
  v_keep_finance boolean := false;
  v_close_enquiry boolean := false;
  v_enquiry_after public.enquiry_status;
  v_finance jsonb;
  v_after jsonb;
  v_invoice uuid;
  v_payment jsonb;
  v_effects jsonb := '{}'::jsonb;
  v_payment_state text;
  v_outstanding numeric;
  v_new_version integer;
  v_result jsonb;
  v_aftercare_sent boolean;
  v_enquiry_status public.enquiry_status;
begin
  if p_session_id is null or p_operation_id is null then
    raise exception 'an appointment and an operation id are required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_details) <> 'object' then
    raise exception 'outcome details must be an object' using errcode = '22023';
  end if;

  -- One operation id is one decision. A retry with the same id and the same
  -- request returns the stored result and repeats no side effect.
  perform pg_advisory_xact_lock(hashtextextended('visit-outcome-op:' || p_operation_id::text, 0));
  v_hash := md5(jsonb_build_object('session', p_session_id, 'outcome', p_outcome,
    'expected', p_expected_version, 'details', v_details)::text);
  select * into v_revision from public.visit_outcome_revisions where operation_id = p_operation_id;
  if found then
    perform crm_private.require_artist_access(v_revision.artist_id, 'manage_sessions');
    if v_revision.session_id <> p_session_id or v_revision.request_hash <> v_hash then
      raise exception 'that outcome operation id was already used for a different request'
        using errcode = '22023';
    end if;
    return v_revision.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_session from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_session.artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(v_session.artist_id);
  v_manage_finance := crm_private.has_artist_capability(v_session.artist_id, 'manage_finance');
  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  v_is_tattoo := v_session.appointment_type in ('tattoo_session', 'touch_up');

  select * into v_outcome from public.visit_outcomes where session_id = v_session.id for update;
  v_has_outcome := found;
  if coalesce(p_expected_version, -1) <> coalesce(v_outcome.version, 0) then
    raise exception 'this visit outcome was changed in another session; reload and try again'
      using errcode = '40001';
  end if;
  v_correction := v_has_outcome and v_outcome.state = 'confirmed';
  v_keep_finance := v_correction and not v_manage_finance
    and v_outcome.outcome = 'attended' and p_outcome = 'attended';

  -- Outcome vocabulary and the session status it implies.
  if v_is_tattoo then
    v_target := case p_outcome
      when 'attended' then 'completed' when 'no_show' then 'no_show'
      when 'cancelled' then 'cancelled' end;
  else
    v_target := case p_outcome
      when 'booked' then 'completed' when 'ready_to_book' then 'completed'
      when 'thinking' then 'completed' when 'declined' then 'completed'
      when 'no_show' then 'no_show' end;
  end if;
  if v_target is null then
    raise exception 'unknown outcome % for this appointment type', p_outcome using errcode = '22023';
  end if;

  -- Timing: no outcome before the visit could have happened.
  if v_is_tattoo then
    if v_session.start_at > v_now then
      raise exception 'this session has not started yet' using errcode = '22023';
    end if;
  elsif v_session.end_at > v_now then
    raise exception 'this consultation has not finished yet' using errcode = '22023';
  end if;

  -- Status eligibility. Draft/proposed bookings were never confirmed. A
  -- cancellation made elsewhere is final; only this workflow's own outcome
  -- may be corrected away from cancelled / no_show.
  if v_session.status in ('draft', 'proposed') then
    raise exception 'an unconfirmed appointment has no visit outcome' using errcode = '22023';
  end if;
  if v_session.status in ('cancelled', 'no_show') and not v_correction
     and v_session.status <> v_target then
    raise exception 'this appointment was already closed as %; reopen it first', v_session.status
      using errcode = '22023';
  end if;

  -- Money already received through this workflow cannot be turned into a
  -- no-show or cancellation; that needs a refund in project finances.
  if v_correction and v_outcome.received_via_outcome > 0 and p_outcome <> 'attended' then
    raise exception 'money was recorded for this visit; refund it in project finances before changing the outcome'
      using errcode = '23514';
  end if;

  v_notes := nullif(btrim(coalesce(v_details ->> 'notes', '')), '');
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'notes are limited to 2000 characters' using errcode = '22023';
  end if;

  -- ------------------------------------------------------------- tattoo
  if v_is_tattoo and p_outcome = 'attended' then
    begin
      v_minutes := (v_details ->> 'worked_minutes')::integer;
      v_price := round((v_details ->> 'final_price')::numeric, 2);
      v_received := coalesce(round((v_details ->> 'received_now')::numeric, 2), 0);
    exception when others then
      raise exception 'duration and amounts must be numbers' using errcode = '22023';
    end;
    if v_minutes is null or v_minutes < 1 or v_minutes > 1440 then
      raise exception 'enter the actual working time (1 minute to 24 hours)' using errcode = '22023';
    end if;
    v_work := coalesce(v_details ->> 'work_result', 'work_complete');
    if v_work not in ('work_complete', 'next_session_needed', 'touch_up_needed') then
      raise exception 'unknown work result' using errcode = '22023';
    end if;
    v_method := nullif(v_details ->> 'payment_method', '');
    if v_method is not null and v_method not in ('cash', 'bank_transfer', 'card', 'other') then
      raise exception 'unknown payment method' using errcode = '22023';
    end if;
    v_outside := coalesce((v_details ->> 'paid_outside_crm')::boolean, false);
    if v_received < 0 or v_received > 100000 then
      raise exception 'the amount received is out of range' using errcode = '22023';
    end if;

    if v_price is null then
      if v_manage_finance then
        raise exception 'enter the final session price' using errcode = '22023';
      end if;
      if v_received > 0 or v_outside then
        raise exception 'recording money requires finance access' using errcode = '42501';
      end if;
    else
      if not v_manage_finance then
        raise exception 'confirming the session price requires finance access' using errcode = '42501';
      end if;
      if v_price <= 0 or v_price > 100000 then
        raise exception 'session price must be between 0.01 and 100000.00' using errcode = '22023';
      end if;
    end if;
    if v_received > 0 and v_method is null then
      raise exception 'choose how the money was received' using errcode = '22023';
    end if;
    if v_received > 0 and v_outside then
      raise exception 'money received now and money received outside the CRM are separate answers'
        using errcode = '22023';
    end if;
  elsif v_is_tattoo then
    if coalesce((v_details ->> 'received_now')::numeric, 0) <> 0 then
      raise exception 'a session that did not happen takes no payment here' using errcode = '22023';
    end if;
  end if;

  -- ------------------------------------------------------- consultation
  if not v_is_tattoo then
    if v_details ?| array['final_price', 'received_now', 'payment_method', 'paid_outside_crm', 'worked_minutes'] then
      raise exception 'consultations are free; no price or payment fields' using errcode = '22023';
    end if;
    if p_outcome = 'booked' then
      begin
        v_linked := (v_details ->> 'linked_session_id')::uuid;
      exception when others then
        raise exception 'invalid booking reference' using errcode = '22023';
      end;
      if v_linked is null or not exists (
        select 1 from public.sessions b
        where b.id = v_linked and b.artist_id = v_session.artist_id
          and b.client_id = v_session.client_id and b.id <> v_session.id
          and b.appointment_type in ('tattoo_session', 'touch_up')
          and b.cancelled_at is null and b.status in ('proposed', 'confirmed', 'completed')
      ) then
        raise exception 'choose an existing tattoo booking of this client' using errcode = '22023';
      end if;
    end if;
    if p_outcome in ('ready_to_book', 'thinking') and nullif(v_details ->> 'follow_up_at', '') is not null then
      begin
        v_follow_at := (v_details ->> 'follow_up_at')::timestamptz;
      exception when others then
        raise exception 'invalid follow-up date' using errcode = '22023';
      end;
      if v_follow_at < v_now - interval '1 day' or v_follow_at > v_now + interval '366 days' then
        raise exception 'the follow-up date must be within the next year' using errcode = '22023';
      end if;
    end if;
    v_close_enquiry := p_outcome = 'declined' and coalesce((v_details ->> 'close_enquiry')::boolean, false);
  end if;

  -- Lifecycle facts at the time of the decision (never revoked).
  v_aftercare_sent := v_is_tattoo and exists (
    select 1 from public.automation_jobs j
    where j.session_id = v_session.id and j.message_purpose = 'post_session_aftercare'
      and j.status = 'completed');

  -- ------------------------------------------------------- status change
  v_status_changed := crm_private.apply_visit_status(v_session, v_target, v_actor_kind);
  if v_status_changed then
    v_effects := v_effects || jsonb_build_object('status_from', v_session.status, 'status_to', v_target);
  end if;
  -- A correction back to a held visit must not release overdue post-session
  -- messages late: the scheduler already cancelled them for no_show/cancelled
  -- and never revives a cancelled job; any still-pending overdue one is
  -- withdrawn here. A message that was already sent stays sent.
  if v_status_changed and v_correction and v_target = 'completed' then
    update public.automation_jobs j
    set status = 'cancelled', cancelled_at = now(), last_error_category = 'appointment_ineligible'
    where j.session_id = v_session.id and j.artist_id = v_session.artist_id
      and j.status = 'pending'
      and j.action_type = 'send_client_message'::public.automation_action_type
      and j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
      and j.scheduled_at <= v_now;
  end if;

  -- ------------------------------------------------------- money (tattoo)
  if v_is_tattoo and p_outcome = 'attended' and v_price is not null then
    v_finance := crm_private.visit_session_finance(v_session.id, v_price);
    if v_price + 0.005 < (v_finance ->> 'deposit_paid')::numeric + (v_finance ->> 'invoiced_paid')::numeric then
      raise exception 'the price is lower than money already recorded for this session' using errcode = '23514';
    end if;
    if v_session.price is distinct from v_price then
      update public.sessions set price = v_price where id = v_session.id;
      perform crm_private.log_artist_activity(
        v_session.artist_id, 'appointment.price_changed', v_actor_kind, auth.uid(),
        v_session.client_id, v_session.enquiry_id, v_session.project_id, v_session.id, null,
        jsonb_build_object('currency', v_session.currency, 'previous_price', v_session.price,
          'price', v_price, 'source', 'visit_outcome'));
      v_effects := v_effects || jsonb_build_object('price_set', true);
    end if;

    if v_received > 0 then
      if jsonb_array_length(v_finance -> 'warnings') > 0 or v_finance ->> 'due' is null then
        raise exception 'payments for this session need review in project finances before recording more'
          using errcode = '23514';
      end if;
      if v_received > (v_finance ->> 'due')::numeric + 0.005 then
        raise exception 'the amount received is more than the remaining balance (%)', v_finance ->> 'due'
          using errcode = '23514';
      end if;
      v_invoice := nullif(v_finance ->> 'payable_invoice_id', '')::uuid;
      if v_invoice is null then
        if (v_finance ->> 'session_invoice_count')::integer <> 0 then
          raise exception 'this session already has an invoice that does not match the balance; review it in project finances'
            using errcode = '23514';
        end if;
        v_invoice := (public.create_invoice(
          v_session.project_id, md5(p_operation_id::text || ':visit-invoice')::uuid, null,
          'Balance for one tattoo session. Deposit recorded separately.') ->> 'invoice_id')::uuid;
        perform public.set_invoice_line_item(v_invoice,
          'Tattoo session balance after allocated deposit', 1, (v_finance ->> 'due')::numeric,
          null, v_session.id, null);
        perform public.issue_invoice(v_invoice, null);
        v_effects := v_effects || jsonb_build_object('invoice_created', v_invoice);
      end if;
      v_payment := public.record_invoice_payment(v_invoice,
        md5(p_operation_id::text || ':visit-payment')::uuid, v_received, v_now, v_method, null);
      v_effects := v_effects || jsonb_build_object('invoice_id', v_invoice,
        'payment_request_id', v_payment ->> 'payment_request_id');
    end if;

    v_after := crm_private.visit_session_finance(v_session.id, v_price);
    if v_after ->> 'due' is null then
      v_payment_state := 'needs_review';
      v_outstanding := null;
    elsif v_outside or (v_after ->> 'due')::numeric = 0 then
      v_payment_state := 'paid';
      v_outstanding := 0;
    elsif (v_after ->> 'deposit_paid')::numeric + (v_after ->> 'invoiced_paid')::numeric > 0 then
      v_payment_state := 'part_paid';
      v_outstanding := (v_after ->> 'due')::numeric;
    else
      v_payment_state := 'unpaid';
      v_outstanding := (v_after ->> 'due')::numeric;
    end if;

    -- The legacy appointment badge only moves up, never down: an earlier
    -- manual "paid" can reflect money taken outside the ledger.
    if v_payment_state = 'paid' and v_session.payment_status <> 'paid' then
      update public.sessions set payment_status = 'paid' where id = v_session.id;
    elsif v_payment_state = 'part_paid' and v_session.payment_status in ('unpaid', 'deposit_paid') then
      update public.sessions set payment_status = 'part_paid' where id = v_session.id;
    end if;
  elsif v_is_tattoo and p_outcome = 'attended' then
    v_payment_state := 'not_recorded';
  end if;

  -- ---------------------------------------------- consultation follow-ups
  -- One reminder per consultation outcome. A correction moves the existing
  -- open reminder, or cancels it when the new answer needs none; it never
  -- leaves a second or obsolete task behind. The reminder is created on the
  -- appointment's own (already authorised) artist, never re-derived from a
  -- client that may be shared by several artists.
  if not v_is_tattoo then
    if v_correction and v_outcome.follow_up_id is not null then
      select f.id into v_existing_follow_up from public.follow_ups f
      where f.id = v_outcome.follow_up_id and f.artist_id = v_session.artist_id and f.status = 'open'
      for update;
    end if;
    if v_follow_at is not null then
      if v_existing_follow_up is not null then
        update public.follow_ups set due_at = v_follow_at,
          subject = case p_outcome when 'ready_to_book' then 'Agree a tattoo date after the consultation'
                                   else 'Check in after the consultation' end
        where id = v_existing_follow_up;
        v_follow_up := v_existing_follow_up;
        v_effects := v_effects || jsonb_build_object('follow_up_moved', v_follow_up);
      else
        perform crm_private.require_role('owner', 'booking_manager');
        perform crm_private.require_artist_access(v_session.artist_id, 'manage');
        insert into public.follow_ups (artist_id, subject, due_at, client_id, enquiry_id, created_by, details)
        values (v_session.artist_id,
          case p_outcome when 'ready_to_book' then 'Agree a tattoo date after the consultation'
                         else 'Check in after the consultation' end,
          v_follow_at, v_session.client_id, v_session.enquiry_id, auth.uid(),
          'Created from the visit outcome; no message is sent automatically.')
        returning id into v_follow_up;
        perform crm_private.log_artist_activity(
          v_session.artist_id, 'follow_up.created', v_actor_kind, auth.uid(),
          v_session.client_id, v_session.enquiry_id, null, null, null,
          jsonb_build_object('follow_up_id', v_follow_up, 'source', 'visit_outcome'));
        v_effects := v_effects || jsonb_build_object('follow_up_id', v_follow_up);
      end if;
    elsif v_existing_follow_up is not null then
      update public.follow_ups set status = 'cancelled', cancelled_at = now()
      where id = v_existing_follow_up;
      v_effects := v_effects || jsonb_build_object('follow_up_cancelled', v_existing_follow_up);
    end if;
  end if;
  if v_close_enquiry and v_session.enquiry_id is not null then
    select e.status into v_enquiry_status from public.enquiries e where e.id = v_session.enquiry_id;
    if v_enquiry_status not in ('declined', 'converted', 'closed') then
      perform public.transition_enquiry_status(v_session.enquiry_id, 'declined');
      v_enquiry_after := 'declined';
      v_effects := v_effects || jsonb_build_object('enquiry_status', 'declined');
    else
      v_enquiry_after := v_enquiry_status;
    end if;
  end if;

  -- --------------------------------------------------------- persist
  v_new_version := coalesce(v_outcome.version, 0) + 1;
  if v_has_outcome then
    update public.visit_outcomes o set
      state = 'confirmed', outcome = p_outcome,
      work_result = case when v_is_tattoo and p_outcome = 'attended' then v_work end,
      worked_minutes = case when v_is_tattoo and p_outcome = 'attended' then v_minutes end,
      -- Someone without finance access may correct time, result or notes,
      -- but never erases money facts an authorised person confirmed.
      final_price = case when v_keep_finance then o.final_price
                         when v_is_tattoo and p_outcome = 'attended' then v_price end,
      currency = case when v_is_tattoo then v_session.currency end,
      deposit_applied = case when v_keep_finance then o.deposit_applied
                             when v_after is not null then (v_after ->> 'deposit_paid')::numeric end,
      previously_received = case when v_keep_finance then o.previously_received
                                 when v_finance is not null then (v_finance ->> 'invoiced_paid')::numeric end,
      received_via_outcome = o.received_via_outcome + v_received,
      outstanding = case when v_keep_finance then o.outstanding else v_outstanding end,
      payment_state = case when v_keep_finance then o.payment_state else v_payment_state end,
      payment_method = case when v_keep_finance then o.payment_method
                            when v_received > 0 then v_method
                            when v_is_tattoo and p_outcome = 'attended' then coalesce(v_method, o.payment_method) end,
      paid_outside_crm = case when v_keep_finance then o.paid_outside_crm else v_outside end,
      linked_session_id = v_linked,
      follow_up_id = v_follow_up,
      enquiry_status_after = coalesce(v_enquiry_after, case when p_outcome = 'declined' then o.enquiry_status_after end),
      notes = v_notes,
      aftercare_sent_before_outcome = v_aftercare_sent,
      deferred_until = null,
      version = v_new_version,
      confirmed_by = coalesce(o.confirmed_by, auth.uid()),
      confirmed_at = coalesce(o.confirmed_at, v_now),
      updated_by = auth.uid()
    where o.id = v_outcome.id
    returning * into v_outcome;
  else
    insert into public.visit_outcomes (
      session_id, artist_id, client_id, appointment_type, state, outcome,
      work_result, worked_minutes, final_price, currency, deposit_applied,
      previously_received, received_via_outcome, outstanding, payment_state,
      payment_method, paid_outside_crm, linked_session_id, follow_up_id,
      enquiry_status_after, notes, aftercare_sent_before_outcome,
      version, confirmed_by, confirmed_at, updated_by
    ) values (
      v_session.id, v_session.artist_id, v_session.client_id, v_session.appointment_type,
      'confirmed', p_outcome,
      case when v_is_tattoo and p_outcome = 'attended' then v_work end,
      case when v_is_tattoo and p_outcome = 'attended' then v_minutes end,
      case when v_is_tattoo and p_outcome = 'attended' then v_price end,
      case when v_is_tattoo then v_session.currency end,
      case when v_after is not null then (v_after ->> 'deposit_paid')::numeric end,
      case when v_finance is not null then (v_finance ->> 'invoiced_paid')::numeric end,
      v_received, v_outstanding, v_payment_state,
      case when v_is_tattoo and p_outcome = 'attended' then v_method end,
      v_outside, v_linked, v_follow_up, v_enquiry_after, v_notes, v_aftercare_sent,
      v_new_version, auth.uid(), v_now, auth.uid()
    ) returning * into v_outcome;
  end if;

  v_result := jsonb_build_object(
    'session_id', v_session.id, 'outcome', p_outcome, 'state', 'confirmed',
    'version', v_new_version, 'correction', v_correction,
    'session_status', v_target, 'payment_state', v_outcome.payment_state,
    'aftercare_already_sent', v_aftercare_sent,
    'effects', v_effects, 'replayed', false);

  insert into public.visit_outcome_revisions (
    operation_id, outcome_id, session_id, artist_id, version, action,
    request_hash, snapshot, effects, result, created_by
  ) values (
    p_operation_id, v_outcome.id, v_session.id, v_session.artist_id, v_new_version,
    case when v_correction then 'correct' else 'confirm' end,
    v_hash, to_jsonb(v_outcome), v_effects, v_result, auth.uid());

  -- Activity carries no money: the activity feed is visible without finance access.
  perform crm_private.log_artist_activity(
    v_session.artist_id, 'visit.outcome_recorded', v_actor_kind, auth.uid(),
    v_session.client_id, v_session.enquiry_id, v_session.project_id, v_session.id, null,
    jsonb_build_object('appointment_type', v_session.appointment_type, 'outcome', p_outcome,
      'correction', v_correction, 'version', v_new_version));

  return v_result;
end;
$fn$;

revoke all on function public.record_visit_outcome(uuid, uuid, integer, text, jsonb) from public, anon;
grant execute on function public.record_visit_outcome(uuid, uuid, integer, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- "Later": keep the card away until a chosen time. Never changes a confirmed
-- outcome and never touches the appointment.
-- ---------------------------------------------------------------------------

create function public.defer_visit_outcome(
  p_session_id uuid,
  p_operation_id uuid,
  p_expected_version integer,
  p_until timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_outcome public.visit_outcomes%rowtype;
  v_has boolean;
  v_revision public.visit_outcome_revisions%rowtype;
  v_hash text;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
  v_version integer;
begin
  if p_session_id is null or p_operation_id is null or p_until is null then
    raise exception 'an appointment, operation id and time are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('visit-outcome-op:' || p_operation_id::text, 0));
  v_hash := md5(jsonb_build_object('session', p_session_id, 'defer', p_until,
    'expected', p_expected_version)::text);
  select * into v_revision from public.visit_outcome_revisions where operation_id = p_operation_id;
  if found then
    perform crm_private.require_artist_access(v_revision.artist_id, 'manage_sessions');
    if v_revision.session_id <> p_session_id or v_revision.request_hash <> v_hash then
      raise exception 'that outcome operation id was already used for a different request'
        using errcode = '22023';
    end if;
    return v_revision.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_session from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_session.artist_id, 'manage_sessions');
  if p_until < v_now + interval '10 minutes' or p_until > v_now + interval '14 days' then
    raise exception 'postpone for between 10 minutes and 14 days' using errcode = '22023';
  end if;

  select * into v_outcome from public.visit_outcomes where session_id = v_session.id for update;
  v_has := found;
  if coalesce(p_expected_version, -1) <> coalesce(v_outcome.version, 0) then
    raise exception 'this visit outcome was changed in another session; reload and try again'
      using errcode = '40001';
  end if;
  if v_has and v_outcome.state = 'confirmed' then
    raise exception 'this visit outcome is already confirmed' using errcode = '22023';
  end if;

  v_version := coalesce(v_outcome.version, 0) + 1;
  if v_has then
    update public.visit_outcomes set deferred_until = p_until, version = v_version,
      updated_by = auth.uid()
    where id = v_outcome.id returning * into v_outcome;
  else
    insert into public.visit_outcomes (session_id, artist_id, client_id, appointment_type,
      state, deferred_until, version, updated_by)
    values (v_session.id, v_session.artist_id, v_session.client_id, v_session.appointment_type,
      'deferred', p_until, v_version, auth.uid())
    returning * into v_outcome;
  end if;

  v_result := jsonb_build_object('session_id', v_session.id, 'state', 'deferred',
    'deferred_until', p_until, 'version', v_version, 'replayed', false);
  insert into public.visit_outcome_revisions (operation_id, outcome_id, session_id, artist_id,
    version, action, request_hash, snapshot, result, created_by)
  values (p_operation_id, v_outcome.id, v_session.id, v_session.artist_id, v_version, 'defer',
    v_hash, to_jsonb(v_outcome), v_result, auth.uid());
  return v_result;
end;
$fn$;

revoke all on function public.defer_visit_outcome(uuid, uuid, integer, timestamptz) from public, anon;
grant execute on function public.defer_visit_outcome(uuid, uuid, integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- History of one appointment's outcome (no money without finance access)
-- ---------------------------------------------------------------------------

create function public.list_visit_outcome_history(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_artist uuid;
  v_view_finance boolean;
begin
  select s.artist_id into v_artist from public.sessions s where s.id = p_session_id;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_artist, 'view_sessions');
  v_view_finance := crm_private.has_artist_capability(v_artist, 'view_finance');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'version', r.version, 'action', r.action, 'created_at', r.created_at,
      'created_by_name', left(p.display_name, 80),
      'outcome', r.snapshot ->> 'outcome', 'work_result', r.snapshot ->> 'work_result',
      'deferred_until', r.snapshot ->> 'deferred_until',
      'status_to', r.effects ->> 'status_to'
    ) || case when v_view_finance then jsonb_build_object(
      'final_price', r.snapshot -> 'final_price', 'payment_state', r.snapshot ->> 'payment_state',
      'received_via_outcome', r.snapshot -> 'received_via_outcome') else '{}'::jsonb end
    order by r.version)
    from public.visit_outcome_revisions r
    left join public.profiles p on p.id = r.created_by
    where r.session_id = p_session_id), '[]'::jsonb);
end;
$fn$;

revoke all on function public.list_visit_outcome_history(uuid) from public, anon;
grant execute on function public.list_visit_outcome_history(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Client card: outcomes of a client's visits (badge per appointment)
-- ---------------------------------------------------------------------------

create function public.list_client_visit_outcomes(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id', o.session_id, 'state', o.state, 'outcome', o.outcome,
    'work_result', o.work_result, 'confirmed_at', o.confirmed_at, 'version', o.version
  ) order by o.confirmed_at desc nulls last), '[]'::jsonb)
  from public.visit_outcomes o
  where o.client_id = p_client_id
    and crm_private.has_artist_capability(o.artist_id, 'view_sessions');
$fn$;

revoke all on function public.list_client_visit_outcomes(uuid) from public, anon;
grant execute on function public.list_client_visit_outcomes(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Today: a dedicated, non-urgent section. Ranked after appointment work.
-- ---------------------------------------------------------------------------

create or replace function crm_private.pulse_section(p_kind text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_kind = 'unmatched_inbound' then 'inbox'
    when p_kind = 'conflict' then 'conflicts'
    when p_kind in ('client_follow_up_due', 'client_cold') then 'waiting_on_clients'
    when p_kind = 'integration_failure' then 'system'
    when p_kind = 'visit_outcome' then 'visit_outcomes'
    else 'waiting_for_you'
  end;
$$;

create or replace function crm_private.pulse_rank(p_kind text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_kind
    when 'reschedule_requested' then 10
    when 'reply' then 20
    when 'email_send_failed' then 30
    when 'email_draft_to_approve' then 35
    when 'visit_outcome' then 40
    when 'payment_to_confirm' then 45
    when 'unconfirmed_appointment' then 50
    when 'deposit_outstanding' then 55
    when 'new_enquiry' then 60
    when 'conflict' then 62
    when 'unmatched_inbound' then 65
    when 'overdue_follow_up' then 70
    when 'client_follow_up_due' then 75
    when 'client_cold' then 80
    when 'integration_failure' then 95
    else 99
  end;
$$;

revoke all on function crm_private.pulse_section(text) from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_rank(text) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION crm_private.pulse_items(p_artist_id uuid, p_include_finance boolean, p_include_integrations boolean, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  with now_ as (select coalesce(p_now, clock_timestamp()) as t),
  acks as (
    select a.item_kind, a.entity_id, a.observed_at, a.resurface_at
    from public.attention_acknowledgements a where a.artist_id = p_artist_id
  ),
  att as materialized (
    select * from crm_private.pulse_attention_batch(p_artist_id, (select t from now_))
  ),
  -- Visits whose actual outcome the artist has not confirmed (or postponed).
  visit_due as materialized (
    select * from crm_private.visit_outcome_due(p_artist_id, (select t from now_))
  ),
  live_sessions as (
    select s.* from public.sessions s
    where s.artist_id = p_artist_id and s.cancelled_at is null
      and s.status in ('draft', 'proposed', 'confirmed')
  ),
  conv as (
    select c.*, crm_private.conversation_awaiting_reply_since(c.id) as awaiting_since
    from public.communication_conversations c
    where c.artist_id = p_artist_id and c.state = 'open'
  ),
  -- Email grouped the way the Inbox groups it: one row per real conversation.
  email_threads as (
    select
      case when m.enquiry_id is not null then 'enquiry-' || m.enquiry_id
           when m.client_id is not null then 'client-' || m.client_id
           else 'message-' || m.id end as thread_key,
      m.*
    from public.email_messages m
    where m.artist_id = p_artist_id
  ),
  email_thread_state as (
    select t.thread_key,
      bool_or(t.status = 'failed') as send_failed,
      bool_or(t.status = 'draft' and t.created_by_kind = 'human') as awaiting_approval,
      max(t.created_at) as last_activity_at,
      (array_agg(t.subject order by t.created_at desc, t.id desc))[1] as subject,
      (array_agg(t.client_id order by t.created_at desc, t.id desc))[1] as client_id,
      (array_agg(t.to_email order by t.created_at desc, t.id desc))[1] as to_email
    from email_threads t
    where t.thread_key not like 'message-%'
    group by t.thread_key
  ),
  -- Manual follow-ups by the client they concern: directly, or through the
  -- enquiry or project they were created on.
  client_follow_ups as (
    select coalesce(f.client_id, e.client_id, p.client_id) as client_id, f.status,
           coalesce(f.completed_at, f.cancelled_at) as closed_at
    from public.follow_ups f
    left join public.enquiries e on e.id = f.enquiry_id
    left join public.projects p on p.id = f.project_id
    where f.artist_id = p_artist_id
  ),
  raw as (
    -- A client asking to move a booked time.
    select 'reschedule_requested'::text as kind, 'reschedule-' || s.id as key, s.client_id,
           null::text as subject, '/appointments/' || s.id as href, s.start_at as at, null::text as detail,
           'client_asked_to_reschedule'::text as reason, null::jsonb as ack
    from live_sessions s
    where s.client_response = 'reschedule_requested' and s.start_at >= (select t from now_)

    union all
    -- One card per visit: what happened, how long, what was paid.
    select 'visit_outcome', 'visit-outcome-' || v.session_id, v.client_id, null,
           '/appointments/' || v.session_id, v.end_at, v.appointment_type::text,
           case when v.status = 'completed' then 'visit_outcome_auto_completed'
                else 'visit_outcome_unconfirmed' end,
           null
    from visit_due v

    union all
    -- Linked conversation whose newest actionable inbound the studio has
    -- not answered (crm_private.conversation_awaiting_reply_since).
    select 'reply', 'reply-' || c.id, c.client_id,
           coalesce(c.external_display_label, c.external_username),
           '/inbox/' || c.id, c.awaiting_since, c.channel::text,
           'client_message_unanswered',
           jsonb_build_object('kind', 'conversation_reply', 'entity_id', c.id, 'observed_at', c.awaiting_since)
    from conv c
    where c.awaiting_since is not null
      and (c.client_id is not null or c.enquiry_id is not null)

    union all
    -- A known client whose newest Gmail message is inbound.
    select 'reply', 'gmail-' || g.client_id, g.client_id, null,
           '/inbox/email/client-' || g.client_id, g.last_message_at, left(g.subject, 120),
           'client_email_unanswered',
           case when g.last_message_at is not null then
             jsonb_build_object('kind', 'gmail_reply', 'entity_id', g.client_id, 'observed_at', g.last_message_at)
           end
    from public.gmail_client_metadata_snapshots g
    where g.artist_id = p_artist_id and g.direction = 'inbound'

    union all
    -- Email the CRM failed to send or a person drafted and nobody approved.
    select case when e.send_failed then 'email_send_failed' else 'email_draft_to_approve' end,
           'email-' || e.thread_key, e.client_id, left(e.to_email, 120),
           '/inbox/email/' || e.thread_key, e.last_activity_at, left(e.subject, 120),
           case when e.send_failed then 'email_not_delivered' else 'email_awaiting_approval' end, null
    from email_thread_state e
    where e.send_failed or e.awaiting_approval

    union all
    -- Contradictory authoritative facts (Phase 2 detectors).
    select 'conflict', 'conflict-' || at.client_id || '-' || code, at.client_id, null,
           '/clients/' || at.client_id, null, code, code, null
    from att at, jsonb_array_elements_text(at.a -> 'conflicts') code
    where code <> 'ai_brief_stale'
      -- An unresolved past visit already has its own outcome card.
      and not (code = 'past_session_unresolved'
               and exists (select 1 from visit_due v where v.client_id = at.client_id))

    union all
    -- Money that landed and only needs agreeing with.
    select 'payment_to_confirm', 'payment-' || r.id, pr.client_id, null, '/payments', r.occurred_at,
           r.amount::text || ' ' || r.currency, 'payment_received_unconfirmed', null
    from public.payment_reconciliation_candidates r
    join public.payment_requests pr
      on pr.id = coalesce(r.matched_payment_request_id, r.suggested_payment_request_id)
    where p_include_finance and r.artist_id = p_artist_id
      and r.provider = 'monzo_easy_bank_transfer'
      and r.status in ('matched', 'candidate')
      -- A verified bank transfer can be linked to an already-booked manual receipt.
      -- Such evidence is settled, not an outstanding action, and must not be counted twice.
      and not exists (select 1 from public.monzo_recorded_receipt_links l
                      where l.candidate_id = r.id and l.artist_id = r.artist_id)
      and not exists (select 1 from public.payment_transactions t
                      where t.provider = r.provider and t.provider_transaction_id = r.provider_transaction_id
                        and t.status = 'succeeded')

    union all
    -- A proposed appointment nobody confirmed.
    select 'unconfirmed_appointment', 'unconfirmed-' || s.id, s.client_id, null, '/appointments/' || s.id,
           s.start_at, null, 'appointment_not_confirmed', null
    from live_sessions s
    where s.status in ('draft', 'proposed') and s.start_at >= (select t from now_)

    union all
    -- A booked session whose deposit is outstanding. A merely requested
    -- deposit waits until the session is within the week ahead.
    select 'deposit_outstanding', 'deposit-' || p.id, p.client_id, null, '/projects/' || p.id, nxt.start_at,
           p.deposit_status::text, 'deposit_not_received_for_booking',
           jsonb_build_object('kind', 'deposit_outstanding', 'entity_id', p.id, 'observed_at', p.updated_at)
    from public.projects p
    join lateral (
      select min(s.start_at) as start_at from live_sessions s
      where s.project_id = p.id and s.start_at >= (select t from now_)
    ) nxt on nxt.start_at is not null
    where p.artist_id = p_artist_id
      and p.deposit_status not in ('paid', 'not_required')
      and (p.deposit_status <> 'requested' or nxt.start_at < (select t from now_) + interval '8 days')

    union all
    -- A new enquiry the artist has not answered yet. A person's unsent draft
    -- or a failed send for it is already its own item above.
    select 'new_enquiry', 'enquiry-' || e.id, e.client_id, null, '/enquiries/' || e.id, e.created_at,
           e.project_type, 'new_enquiry_untouched',
           jsonb_build_object('kind', 'new_enquiry', 'entity_id', e.id, 'observed_at', e.created_at)
    from public.enquiries e
    where e.artist_id = p_artist_id and e.archived_at is null and e.status = 'new'
      and e.intake_state = 'complete'
      and not exists (select 1 from public.projects p where p.enquiry_id = e.id)
      and not exists (select 1 from public.sessions s where s.enquiry_id = e.id)
      and not crm_private.enquiry_has_artist_reply(e.id, (select t from now_))
      and not exists (select 1 from email_threads m
                      where m.thread_key in ('enquiry-' || e.id, 'client-' || e.client_id)
                        and m.created_at >= e.created_at
                        and ((m.status = 'draft' and m.created_by_kind = 'human') or m.status = 'failed'))

    union all
    -- Messages from somebody the CRM cannot name yet, as one row. Deciding
    -- who they are is Inbox work; Today only says how many wait. A
    -- personal (not_crm) conversation and one handled outside the CRM for
    -- its current actionable inbound do not count.
    select 'unmatched_inbound', 'unmatched-inbound', null, null, '/inbox?view=unmatched',
           max(c.awaiting_since), count(*)::text, 'unknown_sender_unanswered', null
    from conv c
    where c.client_id is null and c.enquiry_id is null
      and c.awaiting_since is not null
      and not crm_private.conversation_hidden_as_not_crm(c.not_crm_at, c.client_id, c.enquiry_id)
      and not exists (select 1 from acks k
                      where k.item_kind = 'conversation_reply' and k.entity_id = c.id
                        and k.observed_at >= c.awaiting_since)
    having count(*) > 0

    union all
    -- Operator follow-ups past due.
    select 'overdue_follow_up', 'follow-up-' || f.id, f.client_id, left(f.subject, 120),
           case when f.enquiry_id is not null then '/enquiries/' || f.enquiry_id
                when f.project_id is not null then '/projects/' || f.project_id
                when f.client_id is not null then '/clients/' || f.client_id end,
           f.due_at, null, 'follow_up_overdue', null
    from public.follow_ups f
    where f.artist_id = p_artist_id and f.status = 'open' and f.due_at < (select t from now_)

    union all
    -- The studio's last message is unanswered: one item per cycle. The 7-day
    -- and 21-day kinds share the acknowledgement keyed by the cycle, so a
    -- decision taken on day 7 still holds on day 21.
    select case when at.a ->> 'sla_state' = 'cold' then 'client_cold' else 'client_follow_up_due' end,
           'silent-' || at.client_id, at.client_id, null, '/clients/' || at.client_id,
           (at.a ->> 'last_outbound_at')::timestamptz, at.a ->> 'workflow_stage', at.a ->> 'sla_reason',
           jsonb_build_object('kind', 'client_silence', 'entity_id', at.client_id,
                              'observed_at', (at.a ->> 'last_outbound_at')::timestamptz)
    from att at
    where at.a ->> 'sla_reason' in ('client_follow_up_due', 'client_silent')
      and at.a ->> 'last_outbound_at' is not null
      -- A manual follow-up: open, or completed/cancelled during this cycle.
      and not exists (
        select 1 from client_follow_ups f
        where f.client_id = at.client_id
          and (f.status = 'open' or f.closed_at >= (at.a ->> 'last_outbound_at')::timestamptz))
      -- A proposed appointment already has its own row.
      and not exists (
        select 1 from live_sessions s
        where s.client_id = at.client_id and s.status in ('draft', 'proposed')
          and s.start_at >= (select t from now_))
      -- A paid deposit: the next step is the studio's.
      and not exists (
        select 1 from public.projects p
        where p.artist_id = p_artist_id and p.client_id = at.client_id and p.archived_at is null
          and p.status in ('draft', 'active', 'on_hold') and p.deposit_status = 'paid')

    union all
    -- Integration failures, grouped: the detail belongs on the integrations screen.
    select 'integration_failure', 'integration-failures', null, null, '/integrations', null,
           count(*)::text, 'integration_jobs_failed', null
    from public.integration_outbox o
    where p_include_integrations and o.artist_id = p_artist_id and o.status in ('failed', 'dead')
      -- Operator-cancelled attempts are terminal by choice, not provider failures.
      -- Keep the audit rows but never require corrective action for them.
      and coalesce(o.last_error_code, '') not in
          ('operator_cancelled', 'cancelled_by_artist_for_direct_gmail_send')
    having count(*) > 0
  ),
  visible as (
    select r.* from raw r
    where r.ack is null
       or not exists (select 1 from acks k
                      where k.item_kind = r.ack ->> 'kind'
                        and k.entity_id = (r.ack ->> 'entity_id')::uuid
                        and k.observed_at >= (r.ack ->> 'observed_at')::timestamptz
                        -- "Not now" covers the cycle until its time comes.
                        and (k.resurface_at is null or k.resurface_at > (select t from now_)))
  ),
  ranked as (
    select r.*, crm_private.pulse_rank(r.kind) as rank,
      -- Consequence: a booked or paying client's delay outranks a lead's.
      case when (at.a ->> 'workflow_stage') in ('booked', 'scheduling', 'deposit_pending') then 0 else 1 end as tier,
      (select jsonb_build_object('id', n.id, 'action_type', n.action_type, 'reason', left(n.reason, 300))
       from public.client_ai_next_actions n
       where n.artist_id = p_artist_id and n.client_id = r.client_id and n.status = 'open'
       order by n.created_at desc limit 1) as ai_suggestion,
      at.a ->> 'sla_state' as sla_state,
      case when r.kind in ('client_follow_up_due', 'client_cold')
        then crm_private.client_silence_context(p_artist_id, r.client_id, r.at) end as context
    from visible r
    left join att at on at.client_id = r.client_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', r.key, 'kind', r.kind, 'section', crm_private.pulse_section(r.kind), 'reason', r.reason,
    'artist_id', p_artist_id, 'client_id', r.client_id,
    'subject', coalesce(left(c.full_name, 80), r.subject),
    'href', case
      when r.context ->> 'conversation_id' is not null then '/inbox/' || (r.context ->> 'conversation_id')
      when r.context ->> 'channel' = 'email' then '/inbox/email/client-' || r.client_id
      else r.href end,
    'at', r.at, 'detail', r.detail, 'sla_state', r.sla_state,
    'ai_suggestion', r.ai_suggestion, 'acknowledgement', r.ack,
    'context', r.context,
    'rank', r.rank, 'tier', r.tier,
    'urgent', r.rank <= 35 or r.sla_state = 'overdue'
  ) order by r.rank, r.tier, r.at nulls last, r.key), '[]'::jsonb)
  from ranked r
  left join public.clients c on c.id = r.client_id;
$function$;

revoke all on function crm_private.pulse_items(uuid, boolean, boolean, timestamptz)
  from public, anon, authenticated, service_role;

comment on table public.visit_outcomes is
  'Artist-confirmed result of a visit (tattoo session or free consultation). Separate from sessions.status. Money is recorded only through the invoice ledger; this row stores the confirmed figures and links.';
comment on table public.visit_outcome_revisions is
  'Append-only history of visit outcomes, one row per operation id (idempotency key).';
