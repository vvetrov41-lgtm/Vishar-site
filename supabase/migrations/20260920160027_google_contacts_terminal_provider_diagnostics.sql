-- Keep safe Google Contacts provider diagnostics fail-closed.
-- Diagnostic 4xx codes expose only the HTTP bucket and canonical Google API
-- status. They are terminal provider rejections and must never enter the
-- automatic retry loop.

create or replace function public.record_google_contact_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_result_code text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_attempt_count integer;
  v_status public.outbox_status;
  v_terminal boolean := false;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Google Contacts outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Google Contacts worker id is invalid'
      using errcode = '22023';
  end if;

  if p_succeeded is null then
    raise exception 'Google Contacts result is required'
      using errcode = '22023';
  end if;

  if p_succeeded then
    if p_result_code not in ('created', 'existing', 'skipped_invalid') then
      raise exception 'successful Google Contacts result code is invalid'
        using errcode = '22023';
    end if;
  elsif coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Google Contacts result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'google_contact_create'::public.outbox_kind
  for update;

  if not found then
    raise exception 'Google Contacts outbox job is unavailable'
      using errcode = '22023';
  end if;

  if v_job.status = 'succeeded' then
    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased'
     or v_job.leased_by is distinct from p_worker_id then
    raise exception 'Google Contacts outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;

  if p_succeeded then
    v_status := 'succeeded'::public.outbox_status;
  else
    v_terminal := p_error_code in (
      'artist_route_unconfigured',
      'calendar_encryption_key_invalid',
      'calendar_oauth_expired',
      'calendar_provider_rejected',
      'calendar_scope_missing',
      'calendar_token_invalid',
      'google_account_mismatch',
      'google_contact_job_invalid',
      'google_contacts_not_enabled',
      'google_contacts_permission_denied',
      'google_contacts_provider_rejected',
      'google_contacts_scope_missing',
      'provider_route_invalid'
    ) or p_error_code ~
      '^google_contacts_provider_rejected_http_4[0-9]{2}(_[a-z0-9_]+)?$';

    v_status := case
      when v_terminal or v_attempt_count >= v_job.max_attempts
        then 'dead'::public.outbox_status
      else 'failed'::public.outbox_status
    end;
  end if;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead' then o.next_attempt_at
        when p_error_code = 'google_contacts_create_result_unknown'
          then now() + interval '5 minutes'
        else now() + make_interval(
          secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600)
        )
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where o.id = p_outbox_id;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker',
    null,
    v_job.client_id,
    null,
    null,
    null,
    null,
    null,
    null,
    p_outbox_id,
    jsonb_build_object(
      'kind', 'google_contact_create',
      'attempt_count', v_attempt_count,
      'result_code', case when p_succeeded then p_result_code else null end,
      'error_code', case when p_succeeded then null else p_error_code end
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', v_status,
    'attempt_count', v_attempt_count,
    'changed', true,
    'result_code', case when p_succeeded then p_result_code else null end,
    'error_code', case when p_succeeded then null else p_error_code end
  );
end;
$$;

revoke all on function public.record_google_contact_outbox_result(uuid,text,boolean,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_google_contact_outbox_result(uuid,text,boolean,text,text)
  to service_role;

comment on function public.record_google_contact_outbox_result(uuid,text,boolean,text,text) is
  'Backend-only lease-bound Google Contacts acknowledgement with bounded retry/dead-letter semantics and PII-free activity metadata.';
