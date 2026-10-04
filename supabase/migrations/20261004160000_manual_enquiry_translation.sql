-- 20261004160000_manual_enquiry_translation.sql
--
-- Manual Russian translation of a client's enquiry, on the artist's click.
--
-- The client's original text (public.enquiries.idea) stays the source of
-- truth. A translation is stored beside it, keyed by the exact source text
-- (sha256), so an unchanged message is translated once and an edited message
-- is never shown with a stale translation. Nothing is translated
-- automatically, and a failed translation raises no notification of any kind.
--
-- Flow:
--   CRM button -> request_enquiry_translation (artist access checked here)
--     -> cached translation, or a pending job id
--   CRM -> TattooAI Worker /crm/enquiry-translations/<job id>
--     -> service_claim_enquiry_translation -> model -> fidelity checks
--     -> service_complete_enquiry_translation | service_fail_enquiry_translation
--   CRM -> get_enquiry_translation (artist access checked again) -> text
-- The Worker never returns translated text; the browser reads it through the
-- authenticated RPC only, so a job id grants no read access.
--
-- Also: the consultation context for the MCP plugin carries the stored
-- reference-image analyses as written by the vision model, instead of only
-- through the client brief written by a smaller text model.

-- ---------------------------------------------------------------------------
-- 1. Telemetry accepts the new job kind
-- ---------------------------------------------------------------------------

alter table crm_private.ai_runs drop constraint if exists ai_runs_job_kind_check;
alter table crm_private.ai_runs add constraint ai_runs_job_kind_check
  check (job_kind in ('enquiry_intake', 'client_state', 'reference_image', 'enquiry_translation'));

-- ---------------------------------------------------------------------------
-- 2. Translation cache and jobs
-- ---------------------------------------------------------------------------

create table crm_private.enquiry_translations (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  target_language text not null check (target_language in ('ru')),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed')),
  translation text check (translation is null or char_length(translation) between 1 and 24000),
  provider text check (provider is null or provider in ('qwen', 'workers_ai', 'openai')),
  model text check (model is null or model ~ '^[@a-zA-Z0-9/_.:-]{1,160}$'),
  error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  attempts smallint not null default 0 check (attempts between 0 and 20),
  lease_token uuid,
  lease_until timestamptz,
  requested_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint enquiry_translations_succeeded_has_text
    check ((status = 'succeeded') = (translation is not null)),
  unique (enquiry_id, target_language, source_hash)
);

alter table crm_private.enquiry_translations enable row level security;
alter table crm_private.enquiry_translations force row level security;
revoke all on crm_private.enquiry_translations from public, anon, authenticated, service_role;

comment on table crm_private.enquiry_translations is
  'Manual machine translations of enquiries.idea, one per exact source text and language. Read only through RPCs that check artist access. Never replaces the original.';

create or replace function crm_private.enquiry_translation_source_hash(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(coalesce(p_text, ''), 'UTF8')), 'hex');
$$;

revoke all on function crm_private.enquiry_translation_source_hash(text)
  from public, anon, authenticated, service_role;

-- What the browser may see about one translation row. Never the source text.
create or replace function crm_private.enquiry_translation_view(
  p_row crm_private.enquiry_translations,
  p_current_hash text
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public, crm_private
as $$
  select case
    when p_row.id is null then jsonb_build_object('status', 'none')
    else jsonb_build_object(
      'status', p_row.status,
      'job_id', p_row.id,
      'target_language', p_row.target_language,
      'translation', case when p_row.status = 'succeeded' then p_row.translation end,
      'model', case when p_row.status = 'succeeded' then p_row.model end,
      'translated_at', case when p_row.status = 'succeeded' then p_row.completed_at end,
      'error_code', case when p_row.status = 'failed' then p_row.error_code end,
      'source_current', p_row.source_hash = p_current_hash)
  end;
$$;

revoke all on function crm_private.enquiry_translation_view(crm_private.enquiry_translations, text)
  from public, anon, authenticated, service_role;

-- Browser: start or reuse a translation. Returns the cached translation when
-- the source text is unchanged.
create or replace function public.request_enquiry_translation(
  p_enquiry_id uuid,
  p_target_language text default 'ru'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_hash text;
  v_row crm_private.enquiry_translations%rowtype;
begin
  if p_target_language is distinct from 'ru' then
    raise exception 'unsupported translation language' using errcode = '22023';
  end if;
  select e.* into v_enquiry from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'view');

  if nullif(btrim(coalesce(v_enquiry.idea, '')), '') is null then
    return jsonb_build_object('status', 'nothing_to_translate');
  end if;
  if char_length(v_enquiry.idea) > 8000 then
    return jsonb_build_object('status', 'too_long');
  end if;

  v_hash := crm_private.enquiry_translation_source_hash(v_enquiry.idea);

  insert into crm_private.enquiry_translations (artist_id, enquiry_id, target_language, source_hash, requested_by)
  values (v_enquiry.artist_id, v_enquiry.id, p_target_language, v_hash, auth.uid())
  on conflict (enquiry_id, target_language, source_hash) do nothing;

  select t.* into v_row from crm_private.enquiry_translations t
  where t.enquiry_id = v_enquiry.id and t.target_language = p_target_language and t.source_hash = v_hash
  for update;

  -- A failed attempt may be retried by pressing the button again, boundedly.
  if v_row.status = 'failed' and v_row.attempts < 6 then
    update crm_private.enquiry_translations t
    set status = 'pending', error_code = null, requested_by = auth.uid(), updated_at = now()
    where t.id = v_row.id
    returning t.* into v_row;
  end if;

  return crm_private.enquiry_translation_view(v_row, v_hash);
end;
$$;

revoke all on function public.request_enquiry_translation(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.request_enquiry_translation(uuid, text) to authenticated;

-- Browser: read the translation of the current source text, if any. Never
-- starts model work.
create or replace function public.get_enquiry_translation(
  p_enquiry_id uuid,
  p_target_language text default 'ru'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_hash text;
  v_row crm_private.enquiry_translations%rowtype;
begin
  select e.* into v_enquiry from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'view');

  v_hash := crm_private.enquiry_translation_source_hash(v_enquiry.idea);
  select t.* into v_row from crm_private.enquiry_translations t
  where t.enquiry_id = v_enquiry.id and t.target_language = p_target_language and t.source_hash = v_hash;
  return crm_private.enquiry_translation_view(v_row, v_hash);
end;
$$;

revoke all on function public.get_enquiry_translation(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.get_enquiry_translation(uuid, text) to authenticated;

-- Worker: lease one job by id. Only a pending job (or a lease that expired)
-- whose source text is still the enquiry's current text, requested in the
-- last hour. Returns the source text to translate.
create or replace function public.service_claim_enquiry_translation(
  p_job_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row crm_private.enquiry_translations%rowtype;
  v_idea text;
  v_token uuid := gen_random_uuid();
begin
  if not crm_private.is_service_backend() then
    raise exception 'translation claiming is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;

  select t.* into v_row from crm_private.enquiry_translations t
  where t.id = p_job_id
    and t.updated_at > now() - interval '1 hour'
    and (t.status = 'pending' or (t.status = 'processing' and t.lease_until < now()))
  for update skip locked;
  if not found then
    return jsonb_build_object('status', 'not_claimed');
  end if;

  select e.idea into v_idea from public.enquiries e where e.id = v_row.enquiry_id;
  if crm_private.enquiry_translation_source_hash(v_idea) is distinct from v_row.source_hash then
    update crm_private.enquiry_translations t
    set status = 'failed', error_code = 'source_changed', updated_at = now()
    where t.id = v_row.id;
    return jsonb_build_object('status', 'not_claimed');
  end if;

  update crm_private.enquiry_translations t
  set status = 'processing', lease_token = v_token, lease_until = now() + interval '90 seconds',
      attempts = least(t.attempts + 1, 20), updated_at = now()
  where t.id = v_row.id;

  return jsonb_build_object(
    'status', 'claimed', 'job_id', v_row.id, 'lease_token', v_token,
    'target_language', v_row.target_language, 'source_text', v_idea);
end;
$$;

revoke all on function public.service_claim_enquiry_translation(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.service_claim_enquiry_translation(uuid, text) to service_role;

create or replace function public.service_complete_enquiry_translation(
  p_job_id uuid,
  p_lease_token uuid,
  p_translation text,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row crm_private.enquiry_translations%rowtype;
  v_idea text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'translation completion is backend-only' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_translation, '')), '') is null or char_length(p_translation) > 24000
     or p_provider not in ('qwen', 'workers_ai', 'openai')
     or coalesce(p_model, '') !~ '^[@a-zA-Z0-9/_.:-]{1,160}$' then
    raise exception 'invalid translation result' using errcode = '22023';
  end if;

  select t.* into v_row from crm_private.enquiry_translations t
  where t.id = p_job_id and t.status = 'processing' and t.lease_token = p_lease_token
  for update;
  if not found then
    return jsonb_build_object('status', 'not_claimed');
  end if;

  select e.idea into v_idea from public.enquiries e where e.id = v_row.enquiry_id;
  if crm_private.enquiry_translation_source_hash(v_idea) is distinct from v_row.source_hash then
    update crm_private.enquiry_translations t
    set status = 'failed', error_code = 'source_changed', lease_token = null, lease_until = null, updated_at = now()
    where t.id = v_row.id;
    return jsonb_build_object('status', 'source_changed');
  end if;

  update crm_private.enquiry_translations t
  set status = 'succeeded', translation = btrim(p_translation), provider = p_provider, model = p_model,
      error_code = null, lease_token = null, lease_until = null, completed_at = now(), updated_at = now()
  where t.id = v_row.id;
  return jsonb_build_object('status', 'succeeded');
end;
$$;

revoke all on function public.service_complete_enquiry_translation(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.service_complete_enquiry_translation(uuid, uuid, text, text, text) to service_role;

-- A failure is stored for the button to show. It creates no notification.
create or replace function public.service_fail_enquiry_translation(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'translation failure recording is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'a safe error code is required' using errcode = '22023';
  end if;
  update crm_private.enquiry_translations t
  set status = 'failed', error_code = p_error_code, lease_token = null, lease_until = null, updated_at = now()
  where t.id = p_job_id and t.status = 'processing' and t.lease_token = p_lease_token;
  return jsonb_build_object('status', case when found then 'failed' else 'not_claimed' end);
end;
$$;

revoke all on function public.service_fail_enquiry_translation(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.service_fail_enquiry_translation(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Stored reference-image analyses in the consultation context
-- ---------------------------------------------------------------------------

alter function public.gpt_get_consultation_context(uuid) rename to gpt_get_consultation_context_core;
alter function public.gpt_get_consultation_context_core(uuid) set schema crm_private;
revoke all on function crm_private.gpt_get_consultation_context_core(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.gpt_get_consultation_context(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context jsonb;
  v_enquiry_id uuid;
begin
  v_context := crm_private.gpt_get_consultation_context_core(p_appointment_id);
  begin
    v_enquiry_id := nullif(v_context -> 'enquiry' ->> 'enquiry_id', '')::uuid;
  exception when invalid_text_representation then
    v_enquiry_id := null;
  end;
  -- The enquiry section is present only when the caller may read the
  -- enquiry, so the analyses follow exactly the same permission.
  if v_enquiry_id is null or jsonb_typeof(v_context) is distinct from 'object' then
    return v_context;
  end if;

  return v_context || jsonb_build_object('reference_analyses', (
    select coalesce(jsonb_agg(x.item order by x.ordinal), '[]'::jsonb)
    from (
      select f.ordinal, jsonb_build_object(
        'enquiry_file_id', f.id,
        'category', f.category,
        'analysed_at', a.analyzed_at,
        'model', a.model,
        'summary', left(a.summary, 1200),
        'source', 'vision model description of the image; the image itself is authoritative') as item
      from public.enquiry_files f
      join public.enquiry_file_ai_analysis a on a.enquiry_file_id = f.id
      where f.enquiry_id = v_enquiry_id and f.upload_state = 'ready'
      order by f.ordinal
      limit 8
    ) x));
end;
$$;

revoke all on function public.gpt_get_consultation_context(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_consultation_context(uuid) to authenticated;

comment on function public.gpt_get_consultation_context(uuid) is
  'Read-only consultation context for one appointment of the active GPT Artist (see crm_private.gpt_get_consultation_context_core), plus reference_analyses: stored vision-model descriptions of the enquiry''s reference images, unmodified, when the caller may read the enquiry.';
