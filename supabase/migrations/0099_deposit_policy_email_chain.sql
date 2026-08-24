-- 0099_deposit_policy_email_chain.sql
--
-- Make the client-visible deposit policy one coherent service-email chain:
-- deposit request -> paid confirmation -> 72h reminder.
--
-- Authoritative product rule for this migration:
-- If the client cancels within 72 hours of the scheduled start time, the
-- deposit is non-refundable.
--
-- This does not change deposit pricing, settlement, provider routing, scheduler
-- topology or historical paid requests. Existing finance RPCs keep emitting
-- their legacy transactional_email intent; a narrow DB trigger converts only
-- the known deposit_request shape into the existing approved_email contract.

-- ---------------------------------------------------------------------------
-- 1. Template catalogue
-- ---------------------------------------------------------------------------

insert into public.message_template_purposes (purpose, classification, description)
values
  ('deposit_request', 'service', 'Requests the deposit that secures a tattoo booking and states the 72-hour cancellation policy.'),
  ('deposit_confirmation', 'service', 'Confirms receipt of a booking deposit and repeats the 72-hour cancellation policy.')
on conflict (purpose) do update
set classification = excluded.classification,
    description = excluded.description;

insert into public.message_template_variables (variable, description)
values (
  'payment_link',
  'The request-specific first-party payment path for an issued deposit request.'
)
on conflict (variable) do update
set description = excluded.description;

insert into public.message_templates (
  workspace_id, artist_id, purpose, channel, locale, version,
  subject, body, status, created_by
)
select distinct
  a.workspace_id,
  null::uuid,
  'deposit_request',
  'email'::public.message_template_channel,
  'en',
  1,
  'Deposit for your tattoo booking with {{artist_display_name}}',
  E'Hi {{client_first_name}},\n\nA deposit of {{deposit_amount}} is required to secure your tattoo booking with {{artist_display_name}} at {{studio_name}}.\n\nIf you cancel an appointment covered by this deposit within 72 hours of its scheduled start time, the deposit is non-refundable.\n\nPay your deposit here:\nhttps://vishartattoo.com{{payment_link}}\n\nIf you have any questions, reply to this email.\n\n{{studio_name}}',
  'active'::public.message_template_status,
  null::uuid
from public.artists a
join public.workspaces w on w.id = a.workspace_id
where a.is_active
  and w.is_active
  and not exists (
    select 1
    from public.message_templates t
    where t.workspace_id = a.workspace_id
      and t.artist_id is null
      and t.purpose = 'deposit_request'
      and t.channel = 'email'
      and t.locale = 'en'
      and t.status = 'active'
  );

insert into public.message_templates (
  workspace_id, artist_id, purpose, channel, locale, version,
  subject, body, status, created_by
)
select distinct
  a.workspace_id,
  null::uuid,
  'deposit_confirmation',
  'email'::public.message_template_channel,
  'en',
  1,
  'Deposit received for your tattoo booking with {{artist_display_name}}',
  E'Hi {{client_first_name}},\n\nWe have received your {{deposit_amount}} deposit for your tattoo booking with {{artist_display_name}} at {{studio_name}}. Your booking is secured.\n\nAs stated when the deposit was requested, if you cancel an appointment covered by this deposit within 72 hours of its scheduled start time, the deposit is non-refundable.\n\nIf you have any questions, reply to this email.\n\n{{studio_name}}',
  'active'::public.message_template_status,
  null::uuid
from public.artists a
join public.workspaces w on w.id = a.workspace_id
where a.is_active
  and w.is_active
  and not exists (
    select 1
    from public.message_templates t
    where t.workspace_id = a.workspace_id
      and t.artist_id is null
      and t.purpose = 'deposit_confirmation'
      and t.channel = 'email'
      and t.locale = 'en'
      and t.status = 'active'
  );

-- Keep the current active template id stable because lifecycle rules resolve by
-- purpose/channel/locale. The migration updates the reviewed copy in place and
-- increments its version instead of creating a second retired+active pair.
update public.message_templates t
set body = E'Hi {{client_first_name}},\n\nYour tattoo appointment with {{artist_display_name}} at {{studio_name}} is in 72 hours, on {{appointment_date}} at {{appointment_time}}.\n\nPlease note: if a deposit applies to this booking, it is non-refundable if you cancel within 72 hours of the scheduled start time.\n\nIf anything has changed, or you have a question before then, please reply to this email as soon as possible.\n\nSee you soon,\n{{studio_name}}',
    version = t.version + 1,
    updated_at = now()
where t.purpose = 'session_reminder_72h'
  and t.channel = 'email'
  and t.locale = 'en'
  and t.status = 'active';

-- ---------------------------------------------------------------------------
-- 2. Payment provenance on system-approved email
-- ---------------------------------------------------------------------------

alter table public.email_messages
  add column if not exists payment_request_id uuid
    references public.payment_requests(id) on delete restrict;

comment on column public.email_messages.payment_request_id is
  'Authoritative payment request that earned a system-approved deposit email. Exactly one of automation_job_id/payment_request_id is required for system approval.';

create unique index if not exists email_messages_payment_template_key
  on public.email_messages (payment_request_id, template_key)
  where payment_request_id is not null;

alter table public.email_messages
  drop constraint if exists email_messages_approval_required;

alter table public.email_messages
  add constraint email_messages_approval_required
  check (
    status not in ('approved', 'queued', 'sent')
    or (
      approved_at is not null
      and (
        (
          created_by_kind = 'system'
          and approved_by is null
          and created_by is null
          and ((automation_job_id is not null)::int + (payment_request_id is not null)::int) = 1
        )
        or (
          created_by_kind in ('human', 'ai')
          and approved_by is not null
          and automation_job_id is null
          and payment_request_id is null
        )
      )
    )
  );

comment on constraint email_messages_approval_required on public.email_messages is
  'Approved mail is either explicitly human-approved or system-approved by exactly one authoritative lifecycle job or deposit payment request.';

create or replace function crm_private.guard_email_automation_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job_artist uuid;
  v_action public.automation_action_type;
  v_session_id uuid;
  v_session public.sessions%rowtype;
  v_payment public.payment_requests%rowtype;
begin
  if new.automation_job_id is not null and new.payment_request_id is not null then
    raise exception 'system email may have only one provenance source'
      using errcode = '23514';
  end if;

  if new.automation_job_id is not null then
    if new.created_by_kind <> 'system'
       or new.created_by is not null
       or new.approved_by is not null then
      raise exception 'automation email provenance must be system-only'
        using errcode = '23514';
    end if;

    select j.artist_id, j.action_type, j.session_id
      into v_job_artist, v_action, v_session_id
    from public.automation_jobs j
    where j.id = new.automation_job_id;

    if v_job_artist is null
       or v_action <> 'send_client_message'::public.automation_action_type
       or v_session_id is null
       or v_job_artist <> new.artist_id then
      raise exception 'automation email does not match its lifecycle job'
        using errcode = '23514';
    end if;

    select s.* into v_session
    from public.sessions s
    where s.id = v_session_id;

    if not found
       or v_session.artist_id <> new.artist_id
       or v_session.client_id is distinct from new.client_id
       or v_session.enquiry_id is distinct from new.enquiry_id
       or v_session.project_id is distinct from new.project_id then
      raise exception 'automation email links do not match the authoritative session'
        using errcode = '23514';
    end if;

    return new;
  end if;

  if new.payment_request_id is not null then
    if new.created_by_kind <> 'system'
       or new.created_by is not null
       or new.approved_by is not null then
      raise exception 'payment email provenance must be system-only'
        using errcode = '23514';
    end if;

    select r.* into v_payment
    from public.payment_requests r
    where r.id = new.payment_request_id;

    if not found
       or v_payment.purpose <> 'deposit'
       or v_payment.artist_id <> new.artist_id
       or v_payment.client_id is distinct from new.client_id
       or v_payment.project_id is distinct from new.project_id
       or new.enquiry_id is not null
       or new.template_key not in ('deposit_request', 'deposit_confirmation') then
      raise exception 'payment email does not match its authoritative deposit request'
        using errcode = '23514';
    end if;

    if (new.template_key = 'deposit_request'
        and v_payment.status not in ('pending', 'partially_paid'))
       or (new.template_key = 'deposit_confirmation'
           and v_payment.status <> 'paid') then
      raise exception 'payment email does not match the deposit request state'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.guard_email_automation_job()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Deposit rendering and system-approved email creation
-- ---------------------------------------------------------------------------

create or replace function crm_private.render_deposit_template_text(
  p_text text,
  p_payment_request_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_out text := p_text;
  v_client_name text;
  v_artist_name text;
  v_studio_name text;
  v_amount numeric;
  v_currency text;
  v_public_id uuid;
  v_amount_text text;
begin
  if v_out is null or p_payment_request_id is null then
    return null;
  end if;

  select c.full_name,
         a.display_name,
         w.display_name,
         r.amount,
         r.currency,
         l.public_id
    into v_client_name, v_artist_name, v_studio_name,
         v_amount, v_currency, v_public_id
  from public.payment_requests r
  join public.clients c on c.id = r.client_id
  join public.artists a on a.id = r.artist_id
  join public.workspaces w on w.id = a.workspace_id
  left join public.payment_request_links l
    on l.payment_request_id = r.id
   and l.revoked_at is null
  where r.id = p_payment_request_id
    and r.purpose = 'deposit';

  if not found
     or nullif(btrim(v_client_name), '') is null
     or nullif(btrim(v_artist_name), '') is null
     or nullif(btrim(v_studio_name), '') is null
     or v_amount is null
     or v_amount <= 0
     or nullif(btrim(v_currency), '') is null then
    return null;
  end if;

  v_amount_text := case upper(v_currency)
    when 'GBP' then '£' || to_char(v_amount, 'FM999999990.00')
    else to_char(v_amount, 'FM999999990.00') || ' ' || upper(v_currency)
  end;

  v_out := replace(v_out, '{{client_first_name}}',
                   split_part(btrim(v_client_name), ' ', 1));
  v_out := replace(v_out, '{{artist_display_name}}', v_artist_name);
  v_out := replace(v_out, '{{studio_name}}', v_studio_name);
  v_out := replace(v_out, '{{deposit_amount}}', v_amount_text);

  if position('{{payment_link}}' in v_out) > 0 then
    if v_public_id is null then
      return null;
    end if;
    v_out := replace(
      v_out,
      '{{payment_link}}',
      '/pay-by-bank-transfer/' || v_public_id::text
    );
  end if;

  if v_out ~ '\{\{[a-z][a-z0-9_]*\}\}' then
    return null;
  end if;

  return v_out;
end;
$$;

revoke all on function crm_private.render_deposit_template_text(text, uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.create_deposit_email(
  p_payment_request_id uuid,
  p_template_key text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_client public.clients%rowtype;
  v_workspace_id uuid;
  v_template public.message_templates%rowtype;
  v_subject text;
  v_body text;
  v_email_id uuid;
  v_block_reason text;
begin
  if p_payment_request_id is null
     or p_template_key not in ('deposit_request', 'deposit_confirmation') then
    return null;
  end if;

  select r.* into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id
    and r.purpose = 'deposit';

  if not found then
    return null;
  end if;

  if (p_template_key = 'deposit_request'
      and v_request.status not in ('pending', 'partially_paid'))
     or (p_template_key = 'deposit_confirmation'
         and v_request.status <> 'paid') then
    return null;
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = v_request.client_id;

  if not found or nullif(btrim(v_client.email), '') is null then
    return null;
  end if;

  v_block_reason := crm_private.client_send_block_reason(
    v_request.client_id,
    'email'::public.message_template_channel,
    'service'::public.message_classification
  );
  if v_block_reason is not null then
    return null;
  end if;

  select a.workspace_id into v_workspace_id
  from public.artists a
  join public.workspaces w on w.id = a.workspace_id and w.is_active
  where a.id = v_request.artist_id
    and a.is_active;

  if v_workspace_id is null then
    return null;
  end if;

  select t.* into v_template
  from public.message_templates t
  where t.workspace_id = v_workspace_id
    and t.purpose = p_template_key
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and (t.artist_id = v_request.artist_id or t.artist_id is null)
  order by (t.artist_id is null), t.version desc
  limit 1;

  if not found then
    return null;
  end if;

  v_subject := crm_private.render_deposit_template_text(
    v_template.subject,
    v_request.id
  );
  v_body := crm_private.render_deposit_template_text(
    v_template.body,
    v_request.id
  );

  if nullif(btrim(v_subject), '') is null
     or nullif(btrim(v_body), '') is null then
    return null;
  end if;

  insert into public.email_messages (
    status,
    artist_id,
    client_id,
    enquiry_id,
    project_id,
    to_email,
    subject,
    body,
    template_key,
    template_version,
    created_by,
    created_by_kind,
    approved_by,
    approved_at,
    payment_request_id
  ) values (
    'approved',
    v_request.artist_id,
    v_request.client_id,
    null,
    v_request.project_id,
    lower(btrim(v_client.email)),
    v_subject,
    v_body,
    p_template_key,
    v_template.version,
    null,
    'system',
    null,
    now(),
    v_request.id
  )
  on conflict (payment_request_id, template_key)
    where payment_request_id is not null
  do nothing
  returning id into v_email_id;

  if v_email_id is null then
    select m.id into v_email_id
    from public.email_messages m
    where m.payment_request_id = v_request.id
      and m.template_key = p_template_key;
  end if;

  return v_email_id;
end;
$$;

revoke all on function crm_private.create_deposit_email(uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Convert only the legacy deposit transactional_email intent
-- ---------------------------------------------------------------------------

create or replace function crm_private.convert_deposit_transactional_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request_id uuid;
  v_request public.payment_requests%rowtype;
  v_email_id uuid;
begin
  if new.kind <> 'transactional_email'::public.outbox_kind
     or new.payload ->> 'template' <> 'deposit_request' then
    return new;
  end if;

  begin
    v_request_id := nullif(new.payload ->> 'payment_request_id', '')::uuid;
  exception when invalid_text_representation then
    return null;
  end;

  if v_request_id is null then
    return null;
  end if;

  select r.* into v_request
  from public.payment_requests r
  where r.id = v_request_id
    and r.purpose = 'deposit';

  if not found
     or v_request.artist_id <> new.artist_id
     or v_request.client_id is distinct from new.client_id
     or v_request.project_id is distinct from new.project_id
     or v_request.session_id is distinct from new.session_id then
    return null;
  end if;

  v_email_id := crm_private.create_deposit_email(
    v_request.id,
    'deposit_request'
  );

  -- Financial state must not roll back because email is unavailable. Skip the
  -- obsolete outbox row rather than leave a dead kind no Worker consumes.
  if v_email_id is null then
    return null;
  end if;

  new.kind := 'approved_email'::public.outbox_kind;
  new.dedupe_key := 'email:deposit:' || v_request.id::text || ':request';
  new.payload := jsonb_build_object('email_message_id', v_email_id);
  new.email_message_id := v_email_id;
  new.artist_id := v_request.artist_id;
  new.client_id := v_request.client_id;
  new.enquiry_id := null;
  new.project_id := v_request.project_id;
  new.session_id := v_request.session_id;

  return new;
end;
$$;

revoke all on function crm_private.convert_deposit_transactional_email()
  from public, anon, authenticated, service_role;

drop trigger if exists integration_outbox_convert_deposit_email
  on public.integration_outbox;
create trigger integration_outbox_convert_deposit_email
before insert on public.integration_outbox
for each row execute function crm_private.convert_deposit_transactional_email();

-- ---------------------------------------------------------------------------
-- 5. Paid transition queues confirmation through the same approved-email path
-- ---------------------------------------------------------------------------

create or replace function crm_private.queue_paid_deposit_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_email_id uuid;
begin
  if new.purpose <> 'deposit'
     or new.status <> 'paid'
     or old.status = 'paid' then
    return new;
  end if;

  begin
    v_email_id := crm_private.create_deposit_email(
      new.id,
      'deposit_confirmation'
    );

    if v_email_id is not null then
      perform crm_private.enqueue_outbox(
        'approved_email'::public.outbox_kind,
        'email:deposit:' || new.id::text || ':confirmation',
        jsonb_build_object('email_message_id', v_email_id),
        new.client_id,
        null,
        new.project_id,
        new.session_id,
        v_email_id
      );
    end if;
  exception when others then
    -- Settlement remains authoritative. Only SQLSTATE is logged, never client
    -- content or provider credentials.
    raise warning 'deposit confirmation queue failed, sqlstate=%', sqlstate;
  end;

  return new;
end;
$$;

revoke all on function crm_private.queue_paid_deposit_confirmation()
  from public, anon, authenticated, service_role;

drop trigger if exists payment_requests_queue_deposit_confirmation
  on public.payment_requests;
create trigger payment_requests_queue_deposit_confirmation
after update of status on public.payment_requests
for each row
when (
  new.purpose = 'deposit'::public.payment_request_purpose
  and new.status = 'paid'::public.payment_request_status
  and old.status is distinct from new.status
)
execute function crm_private.queue_paid_deposit_confirmation();

-- ---------------------------------------------------------------------------
-- 6. Apply-time invariants
-- ---------------------------------------------------------------------------

do $$
declare
  v_active_workspaces integer;
  v_request_templates integer;
  v_confirmation_templates integer;
  v_72h_templates integer;
begin
  select count(distinct a.workspace_id) into v_active_workspaces
  from public.artists a
  join public.workspaces w on w.id = a.workspace_id
  where a.is_active and w.is_active;

  select count(*) into v_request_templates
  from public.message_templates t
  where t.purpose = 'deposit_request'
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.artist_id is null;

  select count(*) into v_confirmation_templates
  from public.message_templates t
  where t.purpose = 'deposit_confirmation'
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.artist_id is null;

  select count(*) into v_72h_templates
  from public.message_templates t
  where t.purpose = 'session_reminder_72h'
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.artist_id is null
    and t.body like '%if a deposit applies to this booking, it is non-refundable if you cancel within 72 hours of the scheduled start time.%';

  if v_request_templates <> v_active_workspaces
     or v_confirmation_templates <> v_active_workspaces
     or v_72h_templates <> v_active_workspaces then
    raise exception 'deposit policy email templates did not activate for every active workspace'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.message_templates t
    where t.status = 'active'
      and t.purpose in ('deposit_request', 'deposit_confirmation')
      and t.body not like '%within 72 hours%'
  ) then
    raise exception 'deposit templates do not state the 72-hour cancellation boundary'
      using errcode = '23514';
  end if;
end;
$$;
