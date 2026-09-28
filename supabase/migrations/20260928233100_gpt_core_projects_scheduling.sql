-- Unified GPT v2: CRM Core, Projects and Scheduling operator parity.
--
-- Each wrapper resolves the server-owned Artist context, checks the GPT client
-- ceiling and the human's CRM capability, proves record ownership, and calls
-- the same RPC the CRM screen calls. Results are returned as jsonb.

-- ------------------------------------------------------------------ CRM Core

create or replace function public.gpt_list_my_capabilities()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', null);
  return coalesce((select jsonb_agg(to_jsonb(c)) from public.list_capabilities(v_ctx.artist_id) c), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_get_today_pulse()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', null);
  return public.get_today_pulse(v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_archive_client(p_client_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'manage_clients');
  perform crm_private.require_gpt_client_exclusive(p_client_id, v_ctx.artist_id);
  return public.update_client_details(p_client_id, jsonb_build_object('_archive', true));
end;
$$;

create or replace function public.gpt_get_client_ai_state(p_client_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view_clients');
  if not crm_private.gpt_client_in_artist_scope(p_client_id, v_ctx.artist_id) then
    raise exception 'client is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  return public.get_client_ai_state(v_ctx.artist_id, p_client_id);
end;
$$;

create or replace function public.gpt_archive_enquiry(p_enquiry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'manage_enquiries');
  select e.artist_id into v_artist from public.enquiries e where e.id = p_enquiry_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'enquiry');
  return public.update_enquiry_details(p_enquiry_id, jsonb_build_object('_archive', true));
end;
$$;

create or replace function public.gpt_get_enquiry_ai_result(p_enquiry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view_enquiries');
  select e.artist_id into v_artist from public.enquiries e where e.id = p_enquiry_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'enquiry');
  return public.get_enquiry_ai_result(p_enquiry_id);
end;
$$;

create or replace function public.gpt_retry_enquiry_ai(p_enquiry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'manage_enquiries');
  select e.artist_id into v_artist from public.enquiries e where e.id = p_enquiry_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'enquiry');
  return public.retry_enquiry_ai(p_enquiry_id);
end;
$$;

-- ------------------------------------------------------------------ Projects

create or replace function public.gpt_remove_enquiry_file(p_file_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'manage_enquiries');
  select e.artist_id into v_artist
  from public.enquiry_files f join public.enquiries e on e.id = f.enquiry_id
  where f.id = p_file_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'file');
  return public.remove_enquiry_reference_manifest(p_file_id);
end;
$$;

-- ---------------------------------------------------------------- Scheduling

create or replace function public.gpt_schedule_appointment_with_price(
  p_request_id uuid,
  p_client_id uuid,
  p_appointment_type public.appointment_type,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_price numeric,
  p_status public.session_status default 'proposed',
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ctx record;
  v_request jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  if not crm_private.gpt_client_in_artist_scope(p_client_id, v_ctx.artist_id) then
    raise exception 'client is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  v_request := jsonb_build_object('client', p_client_id, 'type', p_appointment_type, 'start', p_start_at,
    'end', p_end_at, 'price', p_price, 'status', p_status, 'enquiry', p_enquiry_id,
    'project', p_project_id, 'notes', p_notes);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'schedule_appointment_with_price', v_request);
  if v_replay is not null then return v_replay; end if;
  v_result := public.schedule_appointment_with_price(v_ctx.artist_id, p_client_id, p_appointment_type,
    p_start_at, p_end_at, p_status, p_enquiry_id, p_project_id, p_notes, p_price);
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'schedule_appointment_with_price', v_request, v_result);
end;
$$;

create or replace function public.gpt_set_appointment_price(p_appointment_id uuid, p_price numeric)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  select s.artist_id into v_artist from public.sessions s where s.id = p_appointment_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'appointment');
  return public.set_appointment_price(p_appointment_id, p_price);
end;
$$;

create or replace function public.gpt_list_booking_conflicts(
  p_appointment_type public.appointment_type,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_appointment_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  return coalesce((select jsonb_agg(to_jsonb(c)) from public.list_booking_conflicts(
    v_ctx.artist_id, p_appointment_type, p_start_at, p_end_at, p_exclude_appointment_id) c), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_schedule_project_session(
  p_request_id uuid,
  p_project_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_status public.session_status default 'proposed',
  p_notes text default null
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ctx record;
  v_artist uuid;
  v_request jsonb;
  v_replay jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  select p.artist_id into v_artist from public.projects p where p.id = p_project_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'project');
  v_request := jsonb_build_object('project', p_project_id, 'start', p_start_at, 'end', p_end_at,
    'status', p_status, 'notes', p_notes);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'schedule_project_session', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'schedule_project_session', v_request,
    public.schedule_session(p_project_id, p_start_at, p_end_at, p_status, p_notes));
end;
$$;

create or replace function public.gpt_set_project_session_status(p_session_id uuid, p_status public.session_status)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  select s.artist_id into v_artist from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'session');
  return public.set_session_status(p_session_id, p_status);
end;
$$;

create or replace function public.gpt_get_session_booking_card_status(p_session_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  select s.artist_id into v_artist from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'session');
  return public.get_session_booking_card_status(p_session_id);
end;
$$;

create or replace function public.gpt_get_scheduling_preferences()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  return public.get_artist_scheduling_preferences(v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_set_scheduling_preferences(
  p_tattoo_earliest_start text,
  p_tattoo_latest_finish text,
  p_tattoo_preferred_starts text[],
  p_consultation_earliest_start text,
  p_consultation_latest_finish text,
  p_consultation_during_tattoo boolean,
  p_max_concurrent_consultations integer
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  return public.set_artist_scheduling_preferences(v_ctx.artist_id, p_tattoo_earliest_start,
    p_tattoo_latest_finish, p_tattoo_preferred_starts, p_consultation_earliest_start,
    p_consultation_latest_finish, p_consultation_during_tattoo, p_max_concurrent_consultations);
end;
$$;

create or replace function public.gpt_list_schedule_overrides(p_from date, p_to date)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  return coalesce((select jsonb_agg(to_jsonb(o)) from public.list_artist_schedule_overrides(v_ctx.artist_id, p_from, p_to) o), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_set_schedule_override(
  p_on_date date,
  p_tattoo_earliest_start text default null,
  p_tattoo_latest_finish text default null,
  p_note text default null
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  return public.set_artist_schedule_override(v_ctx.artist_id, p_on_date, p_tattoo_earliest_start,
    p_tattoo_latest_finish, p_note);
end;
$$;

create or replace function public.gpt_get_session_pricing()
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  return public.get_artist_session_pricing(v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_set_session_pricing(
  p_hourly_rate numeric,
  p_full_day_rate numeric,
  p_full_day_hours numeric,
  p_session_deposit_amount numeric,
  p_currency text default 'GBP'
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  return public.set_artist_session_pricing(v_ctx.artist_id, p_hourly_rate, p_full_day_rate,
    p_full_day_hours, p_session_deposit_amount, p_currency);
end;
$$;

-- --------------------------------------------------------------------- grants

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.gpt_list_my_capabilities()',
    'public.gpt_get_today_pulse()',
    'public.gpt_archive_client(uuid)',
    'public.gpt_get_client_ai_state(uuid)',
    'public.gpt_archive_enquiry(uuid)',
    'public.gpt_get_enquiry_ai_result(uuid)',
    'public.gpt_retry_enquiry_ai(uuid)',
    'public.gpt_remove_enquiry_file(uuid)',
    'public.gpt_schedule_appointment_with_price(uuid,uuid,public.appointment_type,timestamptz,timestamptz,numeric,public.session_status,uuid,uuid,text)',
    'public.gpt_set_appointment_price(uuid,numeric)',
    'public.gpt_list_booking_conflicts(public.appointment_type,timestamptz,timestamptz,uuid)',
    'public.gpt_schedule_project_session(uuid,uuid,timestamptz,timestamptz,public.session_status,text)',
    'public.gpt_set_project_session_status(uuid,public.session_status)',
    'public.gpt_get_session_booking_card_status(uuid)',
    'public.gpt_get_scheduling_preferences()',
    'public.gpt_set_scheduling_preferences(text,text,text[],text,text,boolean,integer)',
    'public.gpt_list_schedule_overrides(date,date)',
    'public.gpt_set_schedule_override(date,text,text,text)',
    'public.gpt_get_session_pricing()',
    'public.gpt_set_session_pricing(numeric,numeric,numeric,numeric,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
