-- 0100_appointment_client_actions_activation.sql
--
-- Activate the already-live 0098 appointment client-action foundation from the
-- existing 24-hour lifecycle emails. No new Worker, scheduler or delivery path.
--
-- Product contract:
--   * tattoo 24h reminder: Confirm attendance / Request reschedule / Cancel;
--   * consultation 24h reminder: the same three actions;
--   * 72h tattoo reminder remains the deposit-policy notice and mints no action;
--   * reschedule remains a request only; the current appointment stays booked
--     until the artist/team agrees and records a new time;
--   * cancellation remains the existing confirmed -> cancelled lifecycle path.
--
-- Security/delivery contract:
--   * capabilities are minted only after the lifecycle job has passed the
--     destination, suppression, template and Gmail integration gates;
--   * the BEFORE INSERT trigger runs after the existing provenance guards;
--   * mint + approved email + outbox remain one database transaction, so a
--     failed insert/outbox rolls capability issuance back;
--   * the raw capability appears only in the approved outbound email content
--     that must carry the link. The private capability registry still stores
--     only SHA-256 digests, and no raw capability is logged or copied to outbox
--     payload metadata.

-- ---------------------------------------------------------------------------
-- 1. Activate reviewed 24-hour copy in place
-- ---------------------------------------------------------------------------

update public.message_templates t
set body = E'Hi {{client_first_name}},\n\nYour tattoo appointment with {{artist_display_name}} at {{studio_name}} is tomorrow, {{appointment_date}}, at {{appointment_time}}.\n\nPlease confirm your plans using one of the secure options below. Each link can be used once.\n\nConfirm attendance:\nhttps://booking.vishartattoo.com/appointments/respond/[[confirm_capability]]\n\nRequest a reschedule:\nhttps://booking.vishartattoo.com/appointments/respond/[[reschedule_capability]]\n\nCancel appointment:\nhttps://booking.vishartattoo.com/appointments/respond/[[cancel_capability]]\n\nA reschedule request does not move your appointment automatically. Your current time remains booked until we contact you and agree a new time.\n\nPlease note: if a deposit applies to this booking, it is already non-refundable at this point.\n\nIf you have a question before then, just reply to this email.\n\nSee you tomorrow,\n{{studio_name}}',
    version = t.version + 1,
    updated_at = now()
where t.purpose = 'session_reminder_24h'
  and t.channel = 'email'
  and t.locale = 'en'
  and t.status = 'active';

update public.message_templates t
set body = E'Hi {{client_first_name}},\n\nYour consultation with {{artist_display_name}} is tomorrow, {{appointment_date}}, at {{appointment_time}}.\n\nPlease bring any reference images or ideas you would like to talk through.\n\nPlease confirm your plans using one of the secure options below. Each link can be used once.\n\nConfirm attendance:\nhttps://booking.vishartattoo.com/appointments/respond/[[confirm_capability]]\n\nRequest a reschedule:\nhttps://booking.vishartattoo.com/appointments/respond/[[reschedule_capability]]\n\nCancel appointment:\nhttps://booking.vishartattoo.com/appointments/respond/[[cancel_capability]]\n\nA reschedule request does not move your appointment automatically. Your current time remains booked until we contact you and agree a new time.\n\nIf you have a question before then, just reply to this email.\n\nSee you tomorrow,\n{{studio_name}}',
    version = t.version + 1,
    updated_at = now()
where t.purpose = 'consultation_reminder'
  and t.channel = 'email'
  and t.locale = 'en'
  and t.status = 'active';

-- ---------------------------------------------------------------------------
-- 2. Last-mile capability injection at the approved-email insert boundary
-- ---------------------------------------------------------------------------

create or replace function crm_private.inject_appointment_client_actions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session_id uuid;
  v_job_purpose text;
  v_confirm text;
  v_reschedule text;
  v_cancel text;
begin
  -- Internal markers must never leak through a non-lifecycle email path.
  if new.template_key not in ('session_reminder_24h', 'consultation_reminder')
     or new.created_by_kind <> 'system'
     or new.automation_job_id is null then
    if coalesce(new.body, '') like '%[[confirm_capability]]%'
       or coalesce(new.body, '') like '%[[reschedule_capability]]%'
       or coalesce(new.body, '') like '%[[cancel_capability]]%' then
      raise exception 'appointment capability markers require an approved 24h lifecycle email'
        using errcode = '23514';
    end if;
    return new;
  end if;

  -- execute_client_lifecycle_job uses INSERT ... ON CONFLICT DO NOTHING for
  -- delivery idempotency. A replay of an already-materialised job must not mint
  -- a fresh capability set and invalidate the links stored in the existing
  -- message. The unique automation_job_id will make this attempted insert a
  -- no-op after BEFORE INSERT triggers return.
  if exists (
    select 1
    from public.email_messages m
    where m.automation_job_id = new.automation_job_id
  ) then
    return new;
  end if;

  select j.session_id, j.message_purpose
    into v_session_id, v_job_purpose
  from public.automation_jobs j
  where j.id = new.automation_job_id
    and j.artist_id = new.artist_id
    and j.action_type = 'send_client_message'::public.automation_action_type;

  if not found
     or v_session_id is null
     or v_job_purpose is distinct from new.template_key then
    raise exception 'appointment action email does not match its lifecycle job'
      using errcode = '23514';
  end if;

  if coalesce(new.subject, '') like '%[[%capability]]%'
     or coalesce(new.body, '') not like '%[[confirm_capability]]%'
     or coalesce(new.body, '') not like '%[[reschedule_capability]]%'
     or coalesce(new.body, '') not like '%[[cancel_capability]]%' then
    raise exception '24h appointment action template is incomplete'
      using errcode = '23514';
  end if;

  select
    max(x.raw_token) filter (where x.action = 'confirm_attendance'::public.appointment_client_action),
    max(x.raw_token) filter (where x.action = 'request_reschedule'::public.appointment_client_action),
    max(x.raw_token) filter (where x.action = 'cancel'::public.appointment_client_action)
  into v_confirm, v_reschedule, v_cancel
  from crm_private.issue_appointment_client_actions(v_session_id) x;

  if v_confirm is null or v_confirm !~ '^[0-9a-f]{64}$'
     or v_reschedule is null or v_reschedule !~ '^[0-9a-f]{64}$'
     or v_cancel is null or v_cancel !~ '^[0-9a-f]{64}$' then
    raise exception 'appointment action capability issuance failed'
      using errcode = '23514';
  end if;

  new.body := replace(new.body, '[[confirm_capability]]', v_confirm);
  new.body := replace(new.body, '[[reschedule_capability]]', v_reschedule);
  new.body := replace(new.body, '[[cancel_capability]]', v_cancel);

  if new.body like '%[[confirm_capability]]%'
     or new.body like '%[[reschedule_capability]]%'
     or new.body like '%[[cancel_capability]]%' then
    raise exception 'appointment capability rendering did not complete'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.inject_appointment_client_actions()
  from public, anon, authenticated, service_role;

drop trigger if exists email_messages_inject_appointment_actions
  on public.email_messages;
create trigger email_messages_inject_appointment_actions
before insert on public.email_messages
for each row execute function crm_private.inject_appointment_client_actions();

-- PostgreSQL executes same-kind triggers alphabetically. The capability trigger
-- intentionally follows both provenance guards so an invalid system-approved
-- row cannot mint a capability before being rejected.
do $$
declare
  v_names text[];
begin
  select array_agg(t.tgname order by t.tgname)
    into v_names
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'email_messages'
    and not t.tgisinternal
    and t.tgtype & 2 = 2;

  if array_position(v_names, 'email_messages_guard_automation_job') is null
     or array_position(v_names, 'email_messages_guard_origin') is null
     or array_position(v_names, 'email_messages_inject_appointment_actions') is null
     or array_position(v_names, 'email_messages_guard_automation_job') > array_position(v_names, 'email_messages_inject_appointment_actions')
     or array_position(v_names, 'email_messages_guard_origin') > array_position(v_names, 'email_messages_inject_appointment_actions') then
    raise exception 'appointment capability trigger must run after email provenance guards'
      using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Apply-time configuration invariants
-- ---------------------------------------------------------------------------

do $$
declare
  v_active_workspaces integer;
  v_action_templates integer;
  v_72h_templates integer;
begin
  select count(distinct a.workspace_id)
    into v_active_workspaces
  from public.artists a
  join public.workspaces w on w.id = a.workspace_id
  where a.is_active and w.is_active;

  select count(*)
    into v_action_templates
  from public.message_templates t
  where t.artist_id is null
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.purpose in ('session_reminder_24h', 'consultation_reminder')
    and t.body like '%https://booking.vishartattoo.com/appointments/respond/[[confirm_capability]]%'
    and t.body like '%https://booking.vishartattoo.com/appointments/respond/[[reschedule_capability]]%'
    and t.body like '%https://booking.vishartattoo.com/appointments/respond/[[cancel_capability]]%';

  if v_action_templates <> v_active_workspaces * 2 then
    raise exception '24h appointment action templates are not active for every workspace'
      using errcode = '23514';
  end if;

  select count(*)
    into v_72h_templates
  from public.message_templates t
  where t.artist_id is null
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.purpose = 'session_reminder_72h'
    and (
      t.body like '%[[confirm_capability]]%'
      or t.body like '%[[reschedule_capability]]%'
      or t.body like '%[[cancel_capability]]%'
    );

  if v_72h_templates <> 0 then
    raise exception '72h deposit reminder must not mint appointment actions'
      using errcode = '23514';
  end if;
end;
$$;
