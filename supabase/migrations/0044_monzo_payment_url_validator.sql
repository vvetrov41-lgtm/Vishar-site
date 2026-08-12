-- 0044_monzo_payment_url_validator.sql
--
-- PostgreSQL ARE repetition bounds are limited to 255. The original draft
-- validators used {4,256}, which raises 2201B before a valid Monzo URL can be
-- evaluated. Replace both new URL-validating functions with equivalent
-- validators using the supported upper bound. No provider connection or
-- production route is enabled here.

create or replace function public.configure_monzo_easy_bank_transfer(
  p_artist_id uuid,
  p_payment_url text,
  p_is_enabled boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_integration_key text;
  v_policy public.artist_payment_policies%rowtype;
  v_next_version integer;
  v_result jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  p_payment_url := btrim(coalesce(p_payment_url, ''));
  if p_payment_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
    raise exception 'Monzo Easy Bank Transfer URL is invalid'
      using errcode = '22023';
  end if;

  v_integration_key := 'monzo_ebt_' || replace(p_artist_id::text, '-', '');

  if p_is_enabled and exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'payments'
      and i.is_enabled
      and not (
        i.provider = 'monzo_easy_bank_transfer'
        and i.integration_key = v_integration_key
      )
  ) then
    raise exception 'disable the existing payment destination before enabling Monzo Easy Bank Transfer'
      using errcode = '22023';
  end if;

  v_result := public.configure_artist_integration(
    p_artist_id,
    'payments',
    'monzo_easy_bank_transfer',
    v_integration_key,
    'Monzo Business Easy Bank Transfer',
    jsonb_build_object(
      'payment_url', p_payment_url,
      'deposit_amount', 250,
      'currency', 'GBP',
      'default_delivery_channel', 'email',
      'email_status', 'provider_not_connected',
      'sms_status', 'not_configured',
      'monzo_api_status', 'not_connected'
    ),
    p_is_enabled
  );

  select * into v_policy
  from public.artist_payment_policies p
  where p.artist_id = p_artist_id
    and p.is_active
    and p.effective_from <= now()
    and (p.effective_until is null or p.effective_until > now())
  order by p.version desc
  limit 1;

  if not found
     or v_policy.deposit_mode <> 'fixed'
     or v_policy.fixed_amount <> 250.00
     or not v_policy.transfer_allowed then
    select coalesce(max(p.version), 0) + 1 into v_next_version
    from public.artist_payment_policies p
    where p.artist_id = p_artist_id;

    perform public.create_artist_payment_policy(
      p_artist_id,
      v_next_version,
      'fixed',
      250.00,
      null,
      72,
      true,
      'monzo-ebt-v1',
      now()
    );
  end if;

  return v_result || jsonb_build_object(
    'deposit_amount', 250,
    'currency', 'GBP',
    'email_status', 'provider_not_connected',
    'sms_status', 'not_configured',
    'monzo_api_status', 'not_connected'
  );
end;
$$;

create or replace function public.resolve_monzo_deposit_redirect(
  p_public_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_link public.payment_request_links%rowtype;
  v_request public.payment_requests%rowtype;
  v_url text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'payment redirect resolution is backend-only'
      using errcode = '42501';
  end if;

  select * into v_link
  from public.payment_request_links l
  where l.public_id = p_public_id
    and l.revoked_at is null
  for update;
  if not found then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  select * into v_request
  from public.payment_requests r
  where r.id = v_link.payment_request_id
    and r.artist_id = v_link.artist_id
    and r.provider = 'monzo_easy_bank_transfer'
    and r.status in ('pending', 'partially_paid')
    and (r.expires_at is null or r.expires_at > now());
  if not found then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  select i.configuration ->> 'payment_url' into v_url
  from public.artist_integrations i
  where i.artist_id = v_link.artist_id
    and i.integration_type = 'payments'
    and i.provider = 'monzo_easy_bank_transfer'
    and i.integration_key = v_request.provider_account_key
    and i.is_enabled;

  if v_url is null
     or v_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  update public.payment_request_links l
  set open_count = l.open_count + 1,
      last_opened_at = now()
  where l.id = v_link.id;

  return v_url;
end;
$$;

revoke all on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_monzo_deposit_redirect(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean)
  to authenticated;
grant execute on function public.resolve_monzo_deposit_redirect(uuid)
  to service_role;

comment on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean) is
  'Finance-authorised setup for one artist reusable Monzo Easy Bank Transfer URL and fixed GBP 250 deposit policy. Stores no Monzo API credential.';
comment on function public.resolve_monzo_deposit_redirect(uuid) is
  'Backend-only redirect resolver. Opening a link never changes payment status or creates a transaction.';
