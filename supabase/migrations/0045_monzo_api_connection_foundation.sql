-- 0045_monzo_api_connection_foundation.sql
--
-- Server-only Monzo Developer API connection metadata. OAuth credentials,
-- access tokens, refresh tokens and webhook route capabilities never enter
-- Postgres. This migration stores only safe status needed by the finance UI.
-- No live Monzo connection, webhook registration or automatic settlement is
-- enabled by this migration.

create table crm_private.monzo_api_connections (
  artist_id uuid primary key references public.artists(id) on delete restrict,
  provider_account_key text not null unique,
  status text not null default 'not_connected',
  account_label text,
  webhook_registered boolean not null default false,
  connected_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint monzo_api_connections_provider_key_check
    check (provider_account_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  constraint monzo_api_connections_status_check
    check (status in (
      'not_connected',
      'oauth_authorized',
      'approval_pending',
      'account_selected',
      'webhook_registered',
      'reauthorization_required',
      'provider_unavailable'
    )),
  constraint monzo_api_connections_account_label_check
    check (account_label is null or (
      char_length(account_label) between 1 and 120
      and account_label !~ '[\u0000-\u001f\u007f]'
    )),
  constraint monzo_api_connections_webhook_state_check
    check ((status = 'webhook_registered') = webhook_registered)
);

alter table crm_private.monzo_api_connections enable row level security;
alter table crm_private.monzo_api_connections force row level security;
revoke all on table crm_private.monzo_api_connections from public, anon, authenticated, service_role;

create or replace function public.set_monzo_api_connection_status(
  p_artist_id uuid,
  p_provider_account_key text,
  p_status text,
  p_account_label text default null,
  p_webhook_registered boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_route_artist_id uuid;
  v_connected_at timestamptz;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Monzo API connection status is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null then
    raise exception 'Monzo API artist is required' using errcode = '22023';
  end if;

  p_provider_account_key := btrim(coalesce(p_provider_account_key, ''));
  p_status := lower(btrim(coalesce(p_status, '')));
  p_account_label := nullif(btrim(coalesce(p_account_label, '')), '');

  if p_provider_account_key !~ '^[a-z][a-z0-9_-]{2,79}$'
     or p_status not in (
       'not_connected',
       'oauth_authorized',
       'approval_pending',
       'account_selected',
       'webhook_registered',
       'reauthorization_required',
       'provider_unavailable'
     )
     or (p_account_label is not null and (
       char_length(p_account_label) > 120
       or p_account_label ~ '[\u0000-\u001f\u007f]'
     ))
     or ((p_status = 'webhook_registered') <> coalesce(p_webhook_registered, false)) then
    raise exception 'Monzo API connection metadata is invalid'
      using errcode = '22023';
  end if;

  v_route_artist_id := crm_private.resolve_payment_route_owner(
    'monzo_easy_bank_transfer', p_provider_account_key
  );
  if v_route_artist_id <> p_artist_id then
    raise exception 'Monzo API route does not belong to artist'
      using errcode = '22023';
  end if;

  if p_status in ('account_selected', 'webhook_registered') and p_account_label is null then
    raise exception 'Monzo API selected account label is required'
      using errcode = '22023';
  end if;

  if p_status = 'not_connected' then
    p_account_label := null;
    p_webhook_registered := false;
  end if;

  select c.connected_at into v_connected_at
  from crm_private.monzo_api_connections c
  where c.artist_id = p_artist_id;

  if p_status in ('oauth_authorized', 'approval_pending', 'account_selected', 'webhook_registered') then
    v_connected_at := coalesce(v_connected_at, now());
  elsif p_status = 'not_connected' then
    v_connected_at := null;
  end if;

  insert into crm_private.monzo_api_connections (
    artist_id,
    provider_account_key,
    status,
    account_label,
    webhook_registered,
    connected_at,
    updated_at
  ) values (
    p_artist_id,
    p_provider_account_key,
    p_status,
    p_account_label,
    coalesce(p_webhook_registered, false),
    v_connected_at,
    now()
  )
  on conflict (artist_id) do update
  set provider_account_key = excluded.provider_account_key,
      status = excluded.status,
      account_label = excluded.account_label,
      webhook_registered = excluded.webhook_registered,
      connected_at = excluded.connected_at,
      updated_at = now();

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'status', p_status,
    'account_label', p_account_label,
    'webhook_registered', coalesce(p_webhook_registered, false),
    'connected', p_status not in ('not_connected', 'reauthorization_required')
  );
end;
$$;

revoke all on function public.set_monzo_api_connection_status(uuid,text,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_monzo_api_connection_status(uuid,text,text,text,boolean)
  to service_role;

create or replace function public.get_monzo_easy_bank_transfer_settings(
  p_artist_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_integration public.artist_integrations%rowtype;
  v_connection crm_private.monzo_api_connections%rowtype;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');

  select * into v_integration
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'payments'
    and i.provider = 'monzo_easy_bank_transfer'
  order by i.updated_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'configured', false,
      'enabled', false,
      'payment_url', null,
      'deposit_amount', 250,
      'currency', 'GBP',
      'default_delivery_channel', 'email',
      'email_status', 'provider_not_connected',
      'sms_status', 'not_configured',
      'monzo_api_status', 'not_connected',
      'monzo_account_label', null,
      'monzo_webhook_registered', false
    );
  end if;

  select * into v_connection
  from crm_private.monzo_api_connections c
  where c.artist_id = p_artist_id
    and c.provider_account_key = v_integration.integration_key;

  return jsonb_build_object(
    'configured', true,
    'enabled', v_integration.is_enabled,
    'payment_url', v_integration.configuration ->> 'payment_url',
    'deposit_amount', 250,
    'currency', 'GBP',
    'default_delivery_channel', 'email',
    'email_status', 'provider_not_connected',
    'sms_status', 'not_configured',
    'monzo_api_status', case when found then v_connection.status else 'not_connected' end,
    'monzo_account_label', case when found then v_connection.account_label else null end,
    'monzo_webhook_registered', case when found then v_connection.webhook_registered else false end
  );
end;
$$;

revoke all on function public.get_monzo_easy_bank_transfer_settings(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_monzo_easy_bank_transfer_settings(uuid)
  to authenticated;

comment on table crm_private.monzo_api_connections is
  'Safe Monzo connection metadata only. OAuth credentials and webhook capabilities stay in encrypted Worker storage.';
comment on function public.set_monzo_api_connection_status(uuid,text,text,text,boolean) is
  'Backend-only safe Monzo API connection status update for the already enabled artist payment route.';
