-- Read-only Meta evidence of WhatsApp Business app Coexistence per artist.
-- Meta's own test for a finished Coexistence number is is_on_biz_app=true
-- with platform_type=CLOUD_API on the business phone number. The drain
-- Worker reads those fields (and the WABA's ownership and review state)
-- with the artist's own binding and records only the enum values here.
-- Nothing in this migration sends, subscribes, syncs or enables anything.
create table crm_private.whatsapp_coexistence_state (
  artist_id uuid primary key references public.artists(id) on delete restrict,
  is_on_biz_app boolean,
  platform_type text check (platform_type is null or platform_type ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  phone_status text check (phone_status is null or phone_status ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  code_verification_status text check (
    code_verification_status is null or code_verification_status ~ '^[A-Z][A-Z0-9_]{1,31}$'
  ),
  waba_ownership_type text check (
    waba_ownership_type is null or waba_ownership_type ~ '^[A-Z][A-Z0-9_]{1,31}$'
  ),
  waba_account_review_status text check (
    waba_account_review_status is null or waba_account_review_status ~ '^[A-Z][A-Z0-9_]{1,31}$'
  ),
  -- Graph code/subcode of a failed read, never message text.
  phone_read_error text check (phone_read_error is null or phone_read_error ~ '^[0-9]{1,6}(/[0-9]{1,9})?$'),
  waba_read_error text check (waba_read_error is null or waba_read_error ~ '^[0-9]{1,6}(/[0-9]{1,9})?$'),
  checked_at timestamptz not null default now()
);
alter table crm_private.whatsapp_coexistence_state enable row level security;
revoke all on crm_private.whatsapp_coexistence_state
  from public,anon,authenticated,service_role;

-- Artists with exactly one enabled Meta route whose evidence is missing or
-- older than one hour. Read-only probe targets; no credentials leave Workers.
create or replace function public.service_claim_whatsapp_coexistence_targets(
  p_limit integer default 4
)
returns table (artist_id uuid, integration_key text)
language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp Coexistence probe is backend-only' using errcode='42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'invalid Coexistence probe limit' using errcode='22023';
  end if;
  return query
  select i.artist_id, i.integration_key
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id=i.artist_id and s.is_active
  left join crm_private.whatsapp_coexistence_state c on c.artist_id=i.artist_id
  where i.integration_type='whatsapp'::public.artist_integration_type
    and i.provider='meta_cloud_api' and i.is_enabled
    and (c.checked_at is null or c.checked_at < now()-interval '1 hour')
    and (select count(*) from public.artist_integrations exact
         where exact.artist_id=i.artist_id
           and exact.integration_type='whatsapp'::public.artist_integration_type
           and exact.provider='meta_cloud_api' and exact.is_enabled)=1
  order by coalesce(c.checked_at,'-infinity'::timestamptz), i.artist_id
  limit p_limit;
end;
$function$;
revoke all on function public.service_claim_whatsapp_coexistence_targets(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.service_claim_whatsapp_coexistence_targets(integer)
  to service_role;

create or replace function public.service_record_whatsapp_coexistence_state(
  p_artist_id uuid,
  p_state jsonb
)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare
  v_enum text := '^[A-Z][A-Z0-9_]{1,31}$';
  v_error text := '^[0-9]{1,6}(/[0-9]{1,9})?$';
  v_key text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp Coexistence evidence is backend-only' using errcode='42501';
  end if;
  if p_artist_id is null or p_state is null or jsonb_typeof(p_state)<>'object'
     or octet_length(p_state::text) > 1024 then
    raise exception 'invalid Coexistence evidence' using errcode='22023';
  end if;
  for v_key in select jsonb_object_keys(p_state) loop
    if v_key not in ('is_on_biz_app','platform_type','phone_status','code_verification_status',
                     'waba_ownership_type','waba_account_review_status',
                     'phone_read_error','waba_read_error') then
      raise exception 'unexpected Coexistence evidence field' using errcode='22023';
    end if;
  end loop;
  if (p_state ? 'is_on_biz_app' and jsonb_typeof(p_state->'is_on_biz_app') not in ('boolean','null'))
     or exists (
       select 1 from jsonb_each(p_state - 'is_on_biz_app' - 'phone_read_error' - 'waba_read_error') e
       where jsonb_typeof(e.value)<>'null'
         and (jsonb_typeof(e.value)<>'string' or e.value#>>'{}' !~ v_enum)
     )
     or exists (
       select 1 from jsonb_each(p_state) e
       where e.key in ('phone_read_error','waba_read_error') and jsonb_typeof(e.value)<>'null'
         and (jsonb_typeof(e.value)<>'string' or e.value#>>'{}' !~ v_error)
     )
  then
    raise exception 'invalid Coexistence evidence value' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.artist_integrations i
    where i.artist_id=p_artist_id
      and i.integration_type='whatsapp'::public.artist_integration_type
      and i.provider='meta_cloud_api' and i.is_enabled
  ) then
    raise exception 'unknown WhatsApp Coexistence target' using errcode='22023';
  end if;
  insert into crm_private.whatsapp_coexistence_state as c (
    artist_id,is_on_biz_app,platform_type,phone_status,code_verification_status,
    waba_ownership_type,waba_account_review_status,phone_read_error,waba_read_error,checked_at
  ) values (
    p_artist_id,
    (p_state->>'is_on_biz_app')::boolean,
    p_state->>'platform_type',
    p_state->>'phone_status',
    p_state->>'code_verification_status',
    p_state->>'waba_ownership_type',
    p_state->>'waba_account_review_status',
    p_state->>'phone_read_error',
    p_state->>'waba_read_error',
    now()
  )
  on conflict (artist_id) do update set
    is_on_biz_app=excluded.is_on_biz_app,
    platform_type=excluded.platform_type,
    phone_status=excluded.phone_status,
    code_verification_status=excluded.code_verification_status,
    waba_ownership_type=excluded.waba_ownership_type,
    waba_account_review_status=excluded.waba_account_review_status,
    phone_read_error=excluded.phone_read_error,
    waba_read_error=excluded.waba_read_error,
    checked_at=now();
  return jsonb_build_object('artist_id',p_artist_id,'checked_at',now());
end;
$function$;
revoke all on function public.service_record_whatsapp_coexistence_state(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.service_record_whatsapp_coexistence_state(uuid,jsonb)
  to service_role;
