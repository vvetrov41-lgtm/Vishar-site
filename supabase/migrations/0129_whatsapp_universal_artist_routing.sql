-- 0129_whatsapp_universal_artist_routing.sql
--
-- Make artist-owned WhatsApp routing self-service without widening the CRM's
-- table privileges or storing provider credentials in Postgres. Production
-- route selectors are globally unique and must be derived from the owning
-- artist slug. A bounded authenticated RPC records a connection only after
-- the trusted CRM provider boundary has completed its external readbacks.

do $$
begin
  if exists (
    select 1
    from public.artist_integrations i
    join public.artists a on a.id = i.artist_id
    where i.integration_type = 'whatsapp'::public.artist_integration_type
      and i.integration_key not in (
        a.slug || '-production',
        a.slug || '-staging'
      )
  ) then
    raise exception 'existing WhatsApp integration key is not an exact artist environment route'
      using errcode = '23514';
  end if;

  if exists (
    select i.integration_key
    from public.artist_integrations i
    where i.integration_type = 'whatsapp'::public.artist_integration_type
    group by i.integration_key
    having count(*) > 1
  ) then
    raise exception 'existing WhatsApp integration keys are ambiguous'
      using errcode = '23505';
  end if;
end;
$$;

create unique index if not exists artist_integrations_whatsapp_route_key_unique
  on public.artist_integrations (integration_key)
  where integration_type = 'whatsapp'::public.artist_integration_type;

create or replace function crm_private.enforce_exact_whatsapp_artist_route_key()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
begin
  if new.integration_type <> 'whatsapp'::public.artist_integration_type then
    return new;
  end if;

  select a.slug
    into v_artist_slug
  from public.artists a
  where a.id = new.artist_id;

  if not found then
    raise exception 'artist does not exist'
      using errcode = '23503';
  end if;

  if new.integration_key not in (
    v_artist_slug || '-production',
    v_artist_slug || '-staging'
  ) then
    raise exception 'WhatsApp integration key must be the exact owning artist environment route'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.enforce_exact_whatsapp_artist_route_key()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_exact_whatsapp_artist_route_key
  on public.artist_integrations;
create trigger enforce_exact_whatsapp_artist_route_key
  before insert or update of artist_id, integration_type, integration_key
  on public.artist_integrations
  for each row execute function crm_private.enforce_exact_whatsapp_artist_route_key();

comment on function crm_private.enforce_exact_whatsapp_artist_route_key() is
  'Keeps every WhatsApp binding selector equal to the owning artist slug plus one explicit environment suffix, preventing encrypted Worker binding collisions and ambiguous webhook routes.';

create or replace function public.complete_artist_whatsapp_connection(
  p_artist_id uuid,
  p_integration_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
  v_integration_id uuid;
  v_connected_at timestamptz;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');
  perform crm_private.require_active_artist(p_artist_id);

  select a.slug
    into v_artist_slug
  from public.artists a
  where a.id = p_artist_id
    and a.is_active;

  if not found then
    raise exception 'artist is not active'
      using errcode = '55000';
  end if;

  if p_integration_key is distinct from v_artist_slug || '-production' then
    raise exception 'WhatsApp connection completion requires the exact artist production route'
      using errcode = '22023';
  end if;

  select i.id, i.connected_at
    into v_integration_id, v_connected_at
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.provider = 'meta_cloud_api'
    and i.integration_key = p_integration_key
    and i.is_enabled
    and i.configuration = '{}'::jsonb
  for update;

  if not found then
    raise exception 'artist WhatsApp route is not ready for connected state'
      using errcode = '55000';
  end if;

  if v_connected_at is null then
    v_connected_at := clock_timestamp();

    update public.artist_integrations i
    set connected_at = v_connected_at
    where i.id = v_integration_id;
  end if;

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'integration_key', p_integration_key,
    'is_enabled', true,
    'connected_at', v_connected_at,
    'configuration', '{}'::jsonb
  );
end;
$$;

revoke all on function public.complete_artist_whatsapp_connection(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_artist_whatsapp_connection(uuid, text)
  to authenticated;

comment on function public.complete_artist_whatsapp_connection(uuid, text) is
  'Marks one authorized artist production WhatsApp route connected after the authenticated CRM provider boundary completes Meta subscription and Cloudflare secret-name readbacks. Provider credentials and browser timestamps are never accepted.';
