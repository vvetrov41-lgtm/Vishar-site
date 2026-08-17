-- Artist-scoped Gmail production integration.
--
-- Gmail OAuth credentials and provider thread identifiers remain backend-only.
-- GPT Actions receive only CRM entity identifiers plus opaque thread-context UUIDs.

create table crm_private.gmail_thread_contexts (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete cascade,
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  provider_thread_id text not null,
  subject text not null,
  last_provider_message_id text,
  last_rfc822_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_thread_provider_id_shape check (provider_thread_id ~ '^[A-Za-z0-9_-]{4,255}$'),
  constraint gmail_thread_subject_length check (char_length(subject) between 1 and 998),
  constraint gmail_thread_provider_message_id_shape check (
    last_provider_message_id is null or last_provider_message_id ~ '^[A-Za-z0-9_-]{4,255}$'
  ),
  constraint gmail_thread_rfc822_message_id_length check (
    last_rfc822_message_id is null or char_length(last_rfc822_message_id) between 3 and 998
  ),
  unique (artist_id, enquiry_id, provider_thread_id)
);

revoke all on table crm_private.gmail_thread_contexts from public, anon, authenticated;
grant select, insert, update, delete on table crm_private.gmail_thread_contexts to service_role;

alter table public.email_messages
  add column gmail_thread_context_id uuid;

alter table public.email_messages
  add constraint email_messages_gmail_thread_context_fkey
  foreign key (gmail_thread_context_id)
  references crm_private.gmail_thread_contexts(id)
  on delete set null;

create unique index artist_integrations_one_enabled_email_per_artist
  on public.artist_integrations (artist_id)
  where integration_type = 'email'::public.artist_integration_type and is_enabled;

create or replace function public.gpt_authorize_gmail_enquiry(p_enquiry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_artist_id uuid;
  v_client_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;

  select e.client_id into v_client_id
  from public.enquiries e
  where e.id = p_enquiry_id
    and e.artist_id = v_artist_id;
  if not found then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'artist_id', v_artist_id,
    'enquiry_id', p_enquiry_id,
    'client_id', v_client_id
  );
end;
$function$;

create or replace function public.service_resolve_gmail_target(
  p_artist_id uuid,
  p_enquiry_id uuid,
  p_client_id uuid
)
returns table(
  artist_id uuid,
  enquiry_id uuid,
  client_id uuid,
  client_email text,
  integration_key text,
  mailbox_email text,
  configuration jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_client_email text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail target resolution is backend-only' using errcode = '42501';
  end if;

  select lower(btrim(c.email)) into v_client_email
  from public.enquiries e
  join public.clients c on c.id = e.client_id
  where e.id = p_enquiry_id
    and e.client_id = p_client_id
    and e.artist_id = p_artist_id
    and c.artist_id = p_artist_id;
  if not found or nullif(v_client_email, '') is null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  return query
  select p_artist_id, p_enquiry_id, p_client_id, v_client_email,
         i.integration_key, lower(btrim(i.external_account_label)), i.configuration
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
  where i.artist_id = p_artist_id
    and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google'
    and i.is_enabled
    and nullif(btrim(i.external_account_label), '') is not null;

  if not found then
    raise exception 'artist Gmail integration is unavailable' using errcode = '22023';
  end if;
end;
$function$;

create or replace function public.service_set_gmail_integration(
  p_artist_id uuid,
  p_integration_key text,
  p_mailbox_email text,
  p_scopes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_email text := lower(btrim(coalesce(p_mailbox_email, '')));
  v_scopes text[] := coalesce(p_scopes, array[]::text[]);
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail integration binding is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or coalesce(p_integration_key, '') !~ '^google_gmail_[a-z0-9_-]{2,60}$' then
    raise exception 'safe Gmail artist binding is required' using errcode = '22023';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'verified Gmail mailbox email is required' using errcode = '22023';
  end if;
  if not ('https://www.googleapis.com/auth/gmail.readonly' = any(v_scopes))
     or not ('https://www.googleapis.com/auth/gmail.send' = any(v_scopes)) then
    raise exception 'required Gmail scopes were not granted' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_scopes) s(scope)
    where s.scope = 'https://mail.google.com/'
  ) then
    raise exception 'full Gmail mailbox scope is forbidden' using errcode = '22023';
  end if;

  update public.artist_integrations
  set is_enabled = false, updated_at = now()
  where artist_id = p_artist_id
    and integration_type = 'email'::public.artist_integration_type
    and integration_key <> p_integration_key
    and is_enabled;

  insert into public.artist_integrations (
    artist_id, integration_type, provider, integration_key,
    external_account_label, configuration, is_enabled
  ) values (
    p_artist_id, 'email'::public.artist_integration_type, 'google', p_integration_key,
    v_email,
    jsonb_build_object(
      'scopes', to_jsonb(v_scopes),
      'identity_verified_at', now(),
      'credential_custody', 'backend_only'
    ),
    true
  )
  on conflict (artist_id, integration_type, integration_key)
  do update set
    provider = excluded.provider,
    external_account_label = excluded.external_account_label,
    configuration = excluded.configuration,
    is_enabled = true,
    updated_at = now();

  perform crm_private.log_activity(
    'integration.gmail_connected', 'worker', null,
    null, null, null, null, null, null, null, null,
    jsonb_build_object(
      'artist_id', p_artist_id,
      'integration_key', p_integration_key,
      'provider', 'google',
      'scopes', to_jsonb(v_scopes)
    )
  );

  return jsonb_build_object('artist_id', p_artist_id, 'integration_key', p_integration_key, 'enabled', true);
end;
$function$;

create or replace function public.service_disable_gmail_integration(
  p_artist_id uuid,
  p_integration_key text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail integration disabling is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'safe Gmail disable reason is required' using errcode = '22023';
  end if;

  update public.artist_integrations i
  set is_enabled = false,
      configuration = (i.configuration - 'disabled_reason') || jsonb_build_object('disabled_reason', p_error_code),
      updated_at = now()
  where i.artist_id = p_artist_id
    and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google'
    and i.integration_key = p_integration_key;
  if not found then
    raise exception 'Gmail integration is unavailable' using errcode = '22023';
  end if;

  perform crm_private.log_activity(
    'integration.gmail_disabled', 'worker', null,
    null, null, null, null, null, null, null, null,
    jsonb_build_object('artist_id', p_artist_id, 'integration_key', p_integration_key, 'error_code', p_error_code)
  );
  return jsonb_build_object('artist_id', p_artist_id, 'integration_key', p_integration_key, 'enabled', false);
end;
$function$;

create or replace function public.service_upsert_gmail_thread_context(
  p_artist_id uuid,
  p_enquiry_id uuid,
  p_client_id uuid,
  p_provider_thread_id text,
  p_subject text,
  p_last_provider_message_id text default null,
  p_last_rfc822_message_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail thread context mutation is backend-only' using errcode = '42501';
  end if;
  perform * from public.service_resolve_gmail_target(p_artist_id, p_enquiry_id, p_client_id);

  insert into crm_private.gmail_thread_contexts (
    artist_id, client_id, enquiry_id, provider_thread_id, subject,
    last_provider_message_id, last_rfc822_message_id
  ) values (
    p_artist_id, p_client_id, p_enquiry_id, p_provider_thread_id, btrim(p_subject),
    nullif(btrim(coalesce(p_last_provider_message_id, '')), ''),
    nullif(btrim(coalesce(p_last_rfc822_message_id, '')), '')
  )
  on conflict (artist_id, enquiry_id, provider_thread_id)
  do update set
    client_id = excluded.client_id,
    subject = excluded.subject,
    last_provider_message_id = excluded.last_provider_message_id,
    last_rfc822_message_id = excluded.last_rfc822_message_id,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.service_get_gmail_thread_context(
  p_thread_context_id uuid,
  p_artist_id uuid,
  p_enquiry_id uuid,
  p_client_id uuid
)
returns table(
  thread_context_id uuid,
  provider_thread_id text,
  subject text,
  last_provider_message_id text,
  last_rfc822_message_id text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail thread context resolution is backend-only' using errcode = '42501';
  end if;
  perform * from public.service_resolve_gmail_target(p_artist_id, p_enquiry_id, p_client_id);

  return query
  select c.id, c.provider_thread_id, c.subject, c.last_provider_message_id, c.last_rfc822_message_id
  from crm_private.gmail_thread_contexts c
  where c.id = p_thread_context_id
    and c.artist_id = p_artist_id
    and c.enquiry_id = p_enquiry_id
    and c.client_id = p_client_id;
  if not found then
    raise exception 'Gmail thread context is outside this artist/client scope' using errcode = '42501';
  end if;
end;
$function$;

create or replace function public.gpt_create_gmail_reply_draft(
  p_enquiry_id uuid,
  p_thread_context_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_artist_id uuid;
  v_client_id uuid;
  v_email text;
  v_subject text;
  v_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;

  select e.client_id, lower(btrim(cl.email)) into v_client_id, v_email
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  where e.id = p_enquiry_id
    and e.artist_id = v_artist_id
    and cl.artist_id = v_artist_id;
  if not found then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  if nullif(v_email, '') is null then
    raise exception 'client has no email address' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null or char_length(p_body) > 8000 then
    raise exception 'reply body must be between 1 and 8000 characters' using errcode = '22023';
  end if;

  select c.subject into v_subject
  from crm_private.gmail_thread_contexts c
  where c.id = p_thread_context_id
    and c.artist_id = v_artist_id
    and c.enquiry_id = p_enquiry_id
    and c.client_id = v_client_id;
  if not found then
    raise exception 'Gmail thread context is outside this GPT artist scope' using errcode = '42501';
  end if;

  v_id := public.create_email_draft(
    v_email, v_subject, p_body,
    v_client_id, p_enquiry_id, null, 'ai'
  );
  update public.email_messages
  set gmail_thread_context_id = p_thread_context_id, updated_at = now()
  where id = v_id and artist_id = v_artist_id;

  return jsonb_build_object(
    'email_message_id', v_id,
    'thread_context_id', p_thread_context_id,
    'status', 'draft',
    'subject', v_subject
  );
end;
$function$;

create or replace function public.claim_email_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table(
  outbox_id uuid,
  artist_id uuid,
  email_message_id uuid,
  client_id uuid,
  enquiry_id uuid,
  integration_key text,
  mailbox_email text,
  to_email text,
  subject text,
  body text,
  thread_context_id uuid,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_limit integer := coalesce(p_limit, 10);
  v_lease_seconds integer := coalesce(p_lease_seconds, 120);
begin
  if not crm_private.is_service_backend() then
    raise exception 'email outbox claiming is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;
  if v_limit < 1 or v_limit > 20 or v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'invalid email claim bounds' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    where o.kind = 'approved_email'::public.outbox_kind
      and o.attempt_count < o.max_attempts
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status) and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ), leased as (
    update public.integration_outbox o
    set status = 'leased'::public.outbox_status,
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  )
  select
    l.id, l.artist_id, l.email_message_id, l.client_id, l.enquiry_id,
    i.integration_key, lower(btrim(i.external_account_label)),
    m.to_email, m.subject, m.body, m.gmail_thread_context_id,
    l.attempt_count, l.max_attempts,
    (
      m.id is not null
      and m.artist_id = l.artist_id
      and m.client_id = l.client_id
      and m.status = 'approved'::public.email_message_status
      and lower(btrim(m.to_email)) = lower(btrim(cl.email))
      and i.id is not null
      and i.provider = 'google'
      and i.is_enabled
      and (m.gmail_thread_context_id is null or exists (
        select 1 from crm_private.gmail_thread_contexts gc
        where gc.id = m.gmail_thread_context_id
          and gc.artist_id = l.artist_id
          and gc.client_id = l.client_id
          and gc.enquiry_id = l.enquiry_id
      ))
    ) as job_valid
  from leased l
  left join public.email_messages m on m.id = l.email_message_id
  left join public.clients cl on cl.id = l.client_id and cl.artist_id = l.artist_id
  left join public.artist_integrations i
    on i.artist_id = l.artist_id
   and i.integration_type = 'email'::public.artist_integration_type
   and i.provider = 'google'
   and i.is_enabled
  order by l.next_attempt_at, l.created_at, l.id;
end;
$function$;

create or replace function public.record_email_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_job public.integration_outbox%rowtype;
  v_status public.outbox_status;
  v_attempt_count integer;
  v_provider_message_id text := nullif(btrim(coalesce(p_provider_message_id, '')), '');
begin
  if not crm_private.is_service_backend() then
    raise exception 'email outbox acknowledgement is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' or p_succeeded is null then
    raise exception 'valid email worker result is required' using errcode = '22023';
  end if;
  if p_succeeded and (v_provider_message_id is null or v_provider_message_id !~ '^[A-Za-z0-9_-]{4,255}$') then
    raise exception 'successful Gmail send requires a provider message id' using errcode = '22023';
  end if;
  if not p_succeeded and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Gmail result requires a safe error code' using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id and o.kind = 'approved_email'::public.outbox_kind
  for update;
  if not found then
    raise exception 'email outbox job is unavailable' using errcode = '22023';
  end if;

  if v_job.status = 'succeeded'::public.outbox_status and p_succeeded then
    return jsonb_build_object('outbox_id', p_outbox_id, 'status', v_job.status, 'attempt_count', v_job.attempt_count, 'changed', false);
  end if;
  if v_job.status <> 'leased'::public.outbox_status or v_job.leased_by is distinct from p_worker_id then
    raise exception 'email outbox lease is not owned by this worker' using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
    when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
    else 'failed'::public.outbox_status
  end;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead'::public.outbox_status then o.next_attempt_at
        else now() + make_interval(secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600))
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where o.id = p_outbox_id;

  if p_succeeded then
    update public.email_messages m
    set status = 'sent'::public.email_message_status,
        sent_at = coalesce(m.sent_at, now()),
        failed_at = null,
        provider = 'google_gmail',
        provider_message_id = coalesce(m.provider_message_id, v_provider_message_id),
        error_code = null,
        updated_at = now()
    where m.id = v_job.email_message_id and m.artist_id = v_job.artist_id;
  elsif v_status = 'dead'::public.outbox_status then
    update public.email_messages m
    set status = 'failed'::public.email_message_status,
        failed_at = now(),
        error_code = p_error_code,
        updated_at = now()
    where m.id = v_job.email_message_id and m.artist_id = v_job.artist_id;
  end if;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker', null,
    v_job.client_id, v_job.enquiry_id, v_job.project_id, v_job.session_id,
    null, null, null, p_outbox_id,
    jsonb_build_object(
      'channel', 'email',
      'provider', 'google_gmail',
      'attempt_count', v_attempt_count,
      'error_code', case when p_succeeded then null else p_error_code end,
      'worker_id', p_worker_id,
      'dead_letter', v_status = 'dead'::public.outbox_status
    )
  );

  return jsonb_build_object('outbox_id', p_outbox_id, 'status', v_status, 'attempt_count', v_attempt_count, 'changed', true);
end;
$function$;

revoke all on function public.gpt_authorize_gmail_enquiry(uuid) from public, anon;
grant execute on function public.gpt_authorize_gmail_enquiry(uuid) to authenticated;
revoke all on function public.gpt_create_gmail_reply_draft(uuid, uuid, text) from public, anon;
grant execute on function public.gpt_create_gmail_reply_draft(uuid, uuid, text) to authenticated;

revoke all on function public.service_resolve_gmail_target(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_resolve_gmail_target(uuid, uuid, uuid) to service_role;
revoke all on function public.service_set_gmail_integration(uuid, text, text, text[]) from public, anon, authenticated;
grant execute on function public.service_set_gmail_integration(uuid, text, text, text[]) to service_role;
revoke all on function public.service_disable_gmail_integration(uuid, text, text) from public, anon, authenticated;
grant execute on function public.service_disable_gmail_integration(uuid, text, text) to service_role;
revoke all on function public.service_upsert_gmail_thread_context(uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.service_upsert_gmail_thread_context(uuid, uuid, uuid, text, text, text, text) to service_role;
revoke all on function public.service_get_gmail_thread_context(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_get_gmail_thread_context(uuid, uuid, uuid, uuid) to service_role;
revoke all on function public.claim_email_outbox(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(text, integer, integer) to service_role;
revoke all on function public.record_email_outbox_result(uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.record_email_outbox_result(uuid, text, boolean, text, text) to service_role;
