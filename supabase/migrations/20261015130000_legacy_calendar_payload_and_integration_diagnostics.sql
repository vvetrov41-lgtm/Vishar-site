-- Repair legacy project calendar payloads and read-only GPT integration diagnostics.
-- Leave confirmed bookings, deposit ledger and Google events untouched.
CREATE OR REPLACE FUNCTION crm_private.legacy_schedule_session(p_project_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_status session_status DEFAULT 'proposed'::session_status, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_role       public.crm_role;
  v_session_id uuid;
  v_client_id  uuid;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  if p_status not in ('draft', 'proposed', 'confirmed') then
    raise exception 'a session may only be created as draft, proposed or confirmed'
      using errcode = '22023';
  end if;

  select p.client_id into v_client_id from public.projects p where p.id = p_project_id;
  if v_client_id is null then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  insert into public.sessions (project_id, status, start_at, end_at, duration_hours, notes)
  values (
    p_project_id, p_status, p_start_at, p_end_at,
    round(extract(epoch from (p_end_at - p_start_at))::numeric / 3600, 2),
    p_notes
  )
  returning id into v_session_id;

  perform crm_private.log_activity(
    'session.scheduled',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), v_client_id, null, p_project_id, v_session_id, null, null, null, null,
    jsonb_build_object('status', p_status)
  );

  -- Calendar work is enqueued only for a confirmed session. Draft and proposed
  -- sessions never produce a calendar job, so a tentative date can never leak
  -- into the artist's calendar as a booking.
  if public.session_is_calendar_eligible(p_status) then
    perform crm_private.enqueue_outbox(
      'calendar_create',
      public.calendar_outbox_dedupe_key('create', v_session_id, 0),
      jsonb_build_object('session_id', v_session_id, 'appointment_type', 'tattoo_session'::public.appointment_type, 'calendar_version', 0),
      v_client_id, null, p_project_id, v_session_id
    );
  end if;

  return jsonb_build_object('session_id', v_session_id, 'project_id', p_project_id, 'status', p_status);
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.legacy_set_session_status(p_session_id uuid, p_status session_status)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_role     public.crm_role;
  v_previous public.session_status;
  v_project  uuid;
  v_client   uuid;
  v_version  integer;
  v_event_id text;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  select s.status, s.project_id, s.calendar_version, s.calendar_event_id, p.client_id
    into v_previous, v_project, v_version, v_event_id, v_client
  from public.sessions s join public.projects p on p.id = s.project_id
  where s.id = p_session_id
  for update of s;

  if v_previous is null then
    raise exception 'session % does not exist', p_session_id using errcode = '23503';
  end if;

  if v_previous = p_status then
    return jsonb_build_object(
      'session_id', p_session_id,
      'from_status', v_previous,
      'to_status', p_status,
      'changed', false
    );
  end if;

  if not (
    (v_previous = 'draft' and p_status in ('proposed', 'confirmed', 'cancelled'))
    or (v_previous = 'proposed' and p_status in ('draft', 'confirmed', 'cancelled'))
    or (v_previous = 'confirmed' and p_status in ('completed', 'cancelled', 'no_show'))
  ) then
    raise exception 'session transition % -> % is not allowed', v_previous, p_status
      using errcode = '42501';
  end if;

  update public.sessions s
  set status = p_status,
      cancelled_at = case when p_status = 'cancelled' then now() else null end,
      calendar_version = s.calendar_version + 1
  where s.id = p_session_id;

  perform crm_private.log_activity(
    'session.status_changed',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), v_client, null, v_project, p_session_id, null, null, null, null,
    jsonb_build_object('from_status', v_previous, 'to_status', p_status)
  );

  if public.session_is_calendar_eligible(p_status) and v_event_id is null then
    perform crm_private.enqueue_outbox(
      'calendar_create', public.calendar_outbox_dedupe_key('create', p_session_id, v_version + 1),
      jsonb_build_object('session_id', p_session_id, 'appointment_type', 'tattoo_session'::public.appointment_type, 'calendar_version', v_version + 1),
      v_client, null, v_project, p_session_id
    );
  elsif p_status = 'cancelled' and v_event_id is not null then
    perform crm_private.enqueue_outbox(
      'calendar_cancel', public.calendar_outbox_dedupe_key('cancel', p_session_id, v_version + 1),
      jsonb_build_object('session_id', p_session_id, 'appointment_type', 'tattoo_session'::public.appointment_type, 'calendar_version', v_version + 1),
      v_client, null, v_project, p_session_id
    );
  elsif public.session_is_calendar_eligible(p_status) and v_event_id is not null then
    perform crm_private.enqueue_outbox(
      'calendar_update', public.calendar_outbox_dedupe_key('update', p_session_id, v_version + 1),
      jsonb_build_object('session_id', p_session_id, 'appointment_type', 'tattoo_session'::public.appointment_type, 'calendar_version', v_version + 1),
      v_client, null, v_project, p_session_id
    );
  end if;

  return jsonb_build_object(
    'session_id', p_session_id,
    'from_status', v_previous,
    'to_status', p_status,
    'changed', true
  );
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.enqueue_outbox(p_kind outbox_kind, p_dedupe_key text, p_payload jsonb DEFAULT '{}'::jsonb, p_client_id uuid DEFAULT NULL::uuid, p_enquiry_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_session_id uuid DEFAULT NULL::uuid, p_email_message_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_id uuid := gen_random_uuid();
  v_type public.appointment_type;
  v_version integer;
begin
  -- Validate a calendar job against its canonical appointment at enqueue time.
  if p_kind in ('calendar_create', 'calendar_update', 'calendar_cancel') then
    select s.appointment_type, s.calendar_version into v_type, v_version
    from public.sessions s where s.id = p_session_id;
    if v_type is null
       or p_payload ->> 'session_id' is distinct from p_session_id::text
       or p_payload ->> 'appointment_type' is distinct from v_type::text
       or coalesce(p_payload ->> 'calendar_version', '') !~ '^[0-9]{1,9}$' then
      raise exception 'calendar outbox payload does not match the session'
        using errcode = '23514';
    end if;
    if (p_payload ->> 'calendar_version')::integer is distinct from v_version then
      raise exception 'calendar outbox version does not match the session'
        using errcode = '23514';
    end if;
  end if;
  insert into public.integration_outbox (
    id, kind, dedupe_key, payload, client_id, enquiry_id, project_id, session_id, email_message_id
  ) values (
    v_id, p_kind, p_dedupe_key, coalesce(p_payload, '{}'::jsonb),
    p_client_id, p_enquiry_id, p_project_id, p_session_id, p_email_message_id
  );
  return v_id;
exception when unique_violation then
  -- The same logical job is already queued. That is the dedupe key doing its
  -- job, not an error.
  return null;
end;
$function$;

create or replace function public.gpt_list_integration_status()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  -- Reading health metadata requires CRM read plus the Artist's view grant,
  -- not the ability to mutate provider connections.
  select * into v_ctx from crm_private.require_gpt_context_workspace('crm_read', 'view_integrations');
  return coalesce((
    select jsonb_agg(to_jsonb(s))
    from public.list_integration_status() s
    where (s.owner_kind = 'artist' and s.owner_id = v_ctx.artist_id)
       or (s.owner_kind = 'workspace' and s.owner_id = v_ctx.workspace_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_calendar_connection_status()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view_integrations');
  return coalesce((
    select jsonb_agg(to_jsonb(s)) from public.list_calendar_connection_status() s
    where s.artist_id = v_ctx.artist_id
  ), '[]'::jsonb);
end;
$$;
-- Only repair unsent, current, malformed calendar creates. Never duplicate a
-- provider event or reopen unrelated terminal jobs.
with repaired as (
  update public.integration_outbox o
  set payload = o.payload || jsonb_build_object('appointment_type', s.appointment_type),
      status = 'pending',
      attempt_count = 0,
      last_error_code = null,
      leased_by = null, leased_at = null, lease_expires_at = null,
      next_attempt_at = now(), updated_at = now()
  from public.sessions s
  where o.session_id = s.id
    and o.kind = 'calendar_create'
    and o.status = 'dead'
    and o.last_error_code = 'calendar_job_invalid'
    and not (o.payload ? 'appointment_type')
    and o.payload ->> 'session_id' = s.id::text
    and coalesce(o.payload ->> 'calendar_version', '') ~ '^[0-9]{1,9}$'
    and (o.payload ->> 'calendar_version')::integer = s.calendar_version
    and o.artist_id = s.artist_id
    and o.provider_send_started_at is null
    and s.status = 'confirmed'
    and s.calendar_provider = 'none'
    and s.calendar_event_id is null
    and s.calendar_last_synced_at is null
    and s.calendar_sync_status = 'not_connected'
  returning o.session_id
)
update public.sessions s
set calendar_sync_status = 'queued', calendar_last_error_code = null,
    updated_at = now()
where s.id in (select session_id from repaired);
