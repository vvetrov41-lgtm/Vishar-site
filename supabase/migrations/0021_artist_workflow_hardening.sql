-- 0021_artist_workflow_hardening.sql
--
-- Small forward-only corrections found by the canonical pgTAP harness after
-- introducing artist-scoped workflow RPCs.

create or replace function crm_private.workflow_artist_from_links(
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_artist_count integer;
begin
  perform crm_private.assert_consistent_entity_links(
    p_client_id, p_enquiry_id, p_project_id, p_session_id
  );

  v_artist_id := crm_private.resolve_artist_from_links(
    p_enquiry_id, p_project_id, p_session_id
  );

  if v_artist_id is not null then
    return v_artist_id;
  end if;

  if p_client_id is null then
    raise exception 'an artist-scoped workflow requires an enquiry, project, session or client'
      using errcode = '22023';
  end if;

  select count(*)::integer
    into v_artist_count
  from (
    select distinct x.artist_id
    from (
      select e.artist_id
      from public.enquiries e
      where e.client_id = p_client_id
      union all
      select p.artist_id
      from public.projects p
      where p.client_id = p_client_id
    ) x
  ) scoped_artists;

  if v_artist_count = 0 then
    raise exception 'client has no artist-scoped record; provide a linked enquiry or project'
      using errcode = '22023';
  elsif v_artist_count > 1 then
    raise exception 'client belongs to multiple artist scopes; provide an enquiry, project or session'
      using errcode = '22023';
  end if;

  select x.artist_id
    into v_artist_id
  from (
    select e.artist_id
    from public.enquiries e
    where e.client_id = p_client_id
    union
    select p.artist_id
    from public.projects p
    where p.client_id = p_client_id
  ) x
  limit 1;

  return v_artist_id;
end;
$$;

revoke all on function crm_private.workflow_artist_from_links(uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

-- A replay that omits an explicit expiry must match the server-computed expiry
-- from the original request rather than being rejected because NULL differs.
create or replace function public.create_payment_request(
  p_idempotency_key uuid,
  p_artist_id uuid,
  p_client_id uuid,
  p_purpose public.payment_request_purpose,
  p_amount numeric,
  p_project_id uuid default null,
  p_session_id uuid default null,
  p_currency text default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_existing public.payment_requests%rowtype;
  v_route record;
  v_policy public.artist_payment_policies%rowtype;
  v_currency text;
  v_expires_at timestamptz;
  v_request_id uuid;
  v_policy_snapshot jsonb := '{}'::jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');

  if p_idempotency_key is null then
    raise exception 'payment request idempotency key is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment-request:' || p_idempotency_key::text, 0));

  select * into v_existing
  from public.payment_requests r
  where r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.artist_id <> p_artist_id
       or v_existing.client_id <> p_client_id
       or v_existing.project_id is distinct from p_project_id
       or v_existing.session_id is distinct from p_session_id
       or v_existing.purpose <> p_purpose
       or v_existing.amount <> p_amount
       or v_existing.currency <> coalesce(p_currency, v_existing.currency)
       or (p_expires_at is not null and v_existing.expires_at is distinct from p_expires_at) then
      raise exception 'payment request idempotency key was reused with different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'payment_request_id', v_existing.id,
      'artist_id', v_existing.artist_id,
      'status', v_existing.status,
      'provider', v_existing.provider,
      'provider_account_key', v_existing.provider_account_key,
      'replayed', true
    );
  end if;

  select a.default_currency into v_currency
  from public.artists a
  where a.id = p_artist_id and a.is_active;
  if not found then
    raise exception 'artist is inactive or unavailable' using errcode = '23503';
  end if;

  v_currency := coalesce(p_currency, v_currency);
  if v_currency <> (select a.default_currency from public.artists a where a.id = p_artist_id) then
    raise exception 'payment request currency must match the artist default currency'
      using errcode = '22023';
  end if;

  select * into v_route
  from crm_private.resolve_enabled_payment_route(p_artist_id);

  if p_purpose = 'deposit' then
    select * into v_policy
    from public.artist_payment_policies p
    where p.artist_id = p_artist_id
      and p.is_active
      and p.effective_from <= now()
      and (p.effective_until is null or p.effective_until > now())
    order by p.version desc
    limit 1;

    if not found then
      raise exception 'artist has no active deposit policy'
        using errcode = '22023';
    end if;

    v_policy_snapshot := jsonb_build_object(
      'version', v_policy.version,
      'deposit_mode', v_policy.deposit_mode,
      'payment_deadline_hours', v_policy.payment_deadline_hours,
      'transfer_allowed', v_policy.transfer_allowed,
      'refund_policy_version', v_policy.refund_policy_version
    );
    v_expires_at := coalesce(
      p_expires_at,
      now() + make_interval(hours => v_policy.payment_deadline_hours)
    );
  else
    v_expires_at := p_expires_at;
  end if;

  insert into public.payment_requests (
    idempotency_key, artist_id, client_id, project_id, session_id,
    purpose, amount, currency, provider, provider_account_key,
    policy_id, policy_version, policy_snapshot, expires_at, created_by
  ) values (
    p_idempotency_key, p_artist_id, p_client_id, p_project_id, p_session_id,
    p_purpose, p_amount, v_currency, v_route.provider,
    v_route.provider_account_key,
    case when p_purpose = 'deposit' then v_policy.id else null end,
    case when p_purpose = 'deposit' then v_policy.version else null end,
    v_policy_snapshot, v_expires_at, auth.uid()
  )
  returning id into v_request_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'payment.request_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    p_client_id, null, p_project_id, p_session_id, null,
    jsonb_build_object(
      'purpose', p_purpose,
      'currency', v_currency,
      'provider', v_route.provider
    )
  );

  return jsonb_build_object(
    'payment_request_id', v_request_id,
    'artist_id', p_artist_id,
    'status', 'pending',
    'provider', v_route.provider,
    'provider_account_key', v_route.provider_account_key,
    'replayed', false
  );
end;
$$;

revoke all on function public.create_payment_request(uuid,uuid,uuid,public.payment_request_purpose,numeric,uuid,uuid,text,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.create_payment_request(uuid,uuid,uuid,public.payment_request_purpose,numeric,uuid,uuid,text,timestamptz)
  to authenticated;
