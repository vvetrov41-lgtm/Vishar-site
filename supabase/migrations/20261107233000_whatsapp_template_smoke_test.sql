-- Isolated once-only Meta Utility-template smoke test. No client, booking,
-- appointment, outbound CRM message or payment is created by this feature.
-- Recipient is an already existing WhatsApp conversation; never in source.
create table crm_private.whatsapp_template_smoke_tests (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete restrict,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete restrict,
  purpose text not null default 'consultation_reminder'
    check (purpose = 'consultation_reminder'),
  body_parameters jsonb not null
    check (jsonb_typeof(body_parameters) = 'array' and jsonb_array_length(body_parameters) = 5),
  status text not null default 'pending'
    check (status in ('pending','sending','accepted','failed')),
  provider_message_id text,
  failure_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  constraint whatsapp_smoke_valid_expiry check (expires_at > created_at),
  constraint whatsapp_smoke_provider_limit check (
    provider_message_id is null or char_length(provider_message_id) between 1 and 256
  ),
  constraint whatsapp_smoke_error_limit check (
    failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{2,63}$'
  )
);
create index whatsapp_smoke_pending_idx
  on crm_private.whatsapp_template_smoke_tests(created_at) where status='pending';
alter table crm_private.whatsapp_template_smoke_tests enable row level security;
revoke all on crm_private.whatsapp_template_smoke_tests from public,anon,authenticated,service_role;

-- Atomic consume-before-network. A crashed send remains 'sending' forever,
-- never an automatic resend. No second attempt is possible for the same id.
create or replace function public.service_claim_whatsapp_template_smoke_test()
returns table (
  test_id uuid,
  artist_id uuid,
  integration_key text,
  contact_wa_id text,
  purpose text,
  template_name text,
  template_language text,
  body_parameters jsonb
) language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $fn$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Meta smoke test is backend-only' using errcode='42501';
  end if;
  return query
    with candidate as (
      select t.id, c.integration_key, c.contact_wa_id,
             reg.template_name,reg.template_language
        from crm_private.whatsapp_template_smoke_tests t
        join public.whatsapp_conversations c
          on c.id=t.conversation_id and c.artist_id=t.artist_id
        join crm_private.lifecycle_whatsapp_template_registry reg
          on reg.artist_id=t.artist_id and reg.purpose=t.purpose
        join crm_private.lifecycle_whatsapp_delivery_gates gate
          on gate.artist_id=t.artist_id
        where t.status='pending'
          and t.expires_at>now()
          and t.created_at>now()-interval '12 hours'
          and gate.enabled
          and reg.approval_status='APPROVED'
          and reg.provider_template_id is not null
          and reg.verified_at>now()-interval '24 hours'
          and c.contact_wa_id ~ '^[1-9][0-9]{5,19}$'
          and c.integration_key ~ '^[a-z][a-z0-9_-]{2,79}$'
          and not exists (
            select 1 from jsonb_array_elements(t.body_parameters) p(v)
             where jsonb_typeof(p.v)<>'string'
                or char_length(p.v #>> '{}') not between 1 and 1024
                or p.v #>> '{}' ~ '[[:cntrl:]]'
          )
        order by t.created_at,t.id
        limit 1 for update of t skip locked
    )
    update crm_private.whatsapp_template_smoke_tests t
      set status='sending',claimed_at=now()
    from candidate c
    where t.id=c.id
    returning t.id,t.artist_id,c.integration_key,c.contact_wa_id,
              t.purpose,c.template_name,c.template_language,t.body_parameters;
end;
$fn$;
revoke all on function public.service_claim_whatsapp_template_smoke_test()
  from public,anon,authenticated,service_role;
grant execute on function public.service_claim_whatsapp_template_smoke_test()
  to service_role;

create or replace function public.service_record_whatsapp_template_smoke_result(
  p_test_id uuid, p_accepted boolean, p_provider_message_id text default null,
  p_error_code text default null
) returns boolean language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $fn$
declare v_rows integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Meta smoke result is backend-only' using errcode='42501';
  end if;
  if p_accepted is null or
     (p_accepted and (nullif(btrim(p_provider_message_id),'') is null
                      or char_length(p_provider_message_id)>256)) then
     raise exception 'Meta smoke result invalid' using errcode='22023';
  end if;
  update crm_private.whatsapp_template_smoke_tests
     set status=case when p_accepted then 'accepted' else 'failed' end,
         provider_message_id=case when p_accepted then p_provider_message_id else null end,
         failure_code=case when p_accepted then null else
           case when coalesce(p_error_code,'') ~ '^[a-z][a-z0-9_]{2,63}$'
             then p_error_code else 'whatsapp_test_send_failed' end end,
         finished_at=now()
   where id=p_test_id and status='sending';
  get diagnostics v_rows=row_count;
  return v_rows=1;
end;
$fn$;
revoke all on function public.service_record_whatsapp_template_smoke_result(uuid,boolean,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.service_record_whatsapp_template_smoke_result(uuid,boolean,text,text)
  to service_role;
