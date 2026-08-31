-- 0121_vladimir_whatsapp_connected_state.sql
--
-- The CRM intentionally has no direct UPDATE privilege on artist_integrations.
-- Complete Vladimir's existing-account WhatsApp provisioning through one
-- bounded RPC instead of widening the table grant or giving the CRM Pages
-- Function a Supabase backend credential.

create or replace function public.complete_vladimir_whatsapp_connection()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id constant uuid := 'a1111111-1111-4111-8111-111111111111';
  v_integration_id uuid;
  v_connected_at timestamptz;
begin
  perform crm_private.require_artist_access(v_artist_id, 'manage_integrations');
  perform crm_private.require_active_artist(v_artist_id);

  select i.id
    into v_integration_id
  from public.artist_integrations i
  where i.artist_id = v_artist_id
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.provider = 'meta_cloud_api'
    and i.integration_key = 'vladimir-production'
    and i.is_enabled
    and i.configuration = '{}'::jsonb
  for update;

  if not found then
    raise exception 'Vladimir WhatsApp route is not ready for connected state'
      using errcode = '55000';
  end if;

  v_connected_at := clock_timestamp();

  update public.artist_integrations i
  set connected_at = v_connected_at
  where i.id = v_integration_id;

  return jsonb_build_object(
    'artist_id', v_artist_id,
    'integration_key', 'vladimir-production',
    'is_enabled', true,
    'connected_at', v_connected_at,
    'configuration', '{}'::jsonb
  );
end;
$$;

revoke all on function public.complete_vladimir_whatsapp_connection()
  from public, anon, authenticated, service_role;
grant execute on function public.complete_vladimir_whatsapp_connection()
  to authenticated;

comment on function public.complete_vladimir_whatsapp_connection() is
  'Marks only Vladimir''s fixed production WhatsApp route connected after the authenticated CRM provider boundary completes Meta and Cloudflare readbacks. The function accepts no browser routing or timestamp input.';
