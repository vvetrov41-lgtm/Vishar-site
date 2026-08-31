-- 0124_dismiss_failed_email_warning.sql
--
-- A failed delivery can become obsolete after the operator fixes the client
-- record or the booking moves on. Keep the immutable delivery history, but let
-- an authorised operator close the warning without retrying or deleting mail.

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

    -- Dismissing a failed warning changes only its terminal display state. It
    -- does not retry, reroute, rewrite or erase the original delivery evidence.
    -- This narrow exception is intentionally after provenance validation so a
    -- stale deposit-request failure can still be closed after the request has
    -- moved to paid.
    if tg_op = 'UPDATE'
       and old.status = 'failed'::public.email_message_status
       and new.status = 'cancelled'::public.email_message_status
       and (to_jsonb(new) - array['status','updated_at'])
         = (to_jsonb(old) - array['status','updated_at']) then
      return new;
    end if;

    if (new.template_key = 'deposit_request'
        and v_payment.status not in ('pending', 'partially_paid'))
       or (new.template_key = 'deposit_confirmation'
           and v_payment.status <> 'paid') then
      -- The owned-lease acknowledgement may close an obsolete approved email.
      -- It cannot change content, routing, provenance or sent/provider fields,
      -- and cannot turn an obsolete payment email back into a sendable state.
      if tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'failed'
         and new.error_code = 'gmail_deposit_email_obsolete'
         and crm_private.is_service_backend()
         and (to_jsonb(new) - array['status','failed_at','error_code','updated_at'])
           = (to_jsonb(old) - array['status','failed_at','error_code','updated_at']) then
        return new;
      end if;
      raise exception 'payment email does not match the deposit request state'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.guard_email_automation_job()
  from public, anon, authenticated, service_role;

create or replace function public.dismiss_failed_email_message(
  p_email_message_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_message public.email_messages%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select m.* into v_message
  from public.email_messages m
  where m.id = p_email_message_id
  for update;

  if not found then
    raise exception 'email message does not exist' using errcode = 'P0002';
  end if;

  perform crm_private.require_artist_access(v_message.artist_id, 'manage');

  if v_message.status = 'cancelled'::public.email_message_status then
    return;
  end if;

  if v_message.status <> 'failed'::public.email_message_status then
    raise exception 'only a failed email can be dismissed' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.integration_outbox o
    where o.email_message_id = v_message.id
      and o.status in ('pending'::public.outbox_status, 'leased'::public.outbox_status)
  ) then
    raise exception 'email still has an active delivery attempt' using errcode = '55000';
  end if;

  perform set_config('app.email_status_guard', 'on', true);

  update public.email_messages
  set status = 'cancelled'::public.email_message_status
  where id = v_message.id;
end;
$$;

revoke all on function public.dismiss_failed_email_message(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.dismiss_failed_email_message(uuid)
  to authenticated;

comment on function public.dismiss_failed_email_message(uuid) is
  'Closes a terminal failed-email warning without retrying, deleting or rewriting delivery history. Only failed to cancelled is allowed and active outbox attempts fail closed.';
