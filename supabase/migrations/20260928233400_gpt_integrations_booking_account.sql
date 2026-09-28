-- Unified GPT v2: Integrations, Booking Sources and own-account operator parity.
--
-- Integration management needs the integrations ceiling, which exists only on
-- the profile-bound unified client. Provider credentials, tokens and routing
-- never pass through these wrappers. Team, membership, role and workspace
-- administration are deliberately not part of this migration.

-- ------------------------------------------------------------- Integrations

create or replace function public.gpt_list_integration_status()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('integrations', 'view_integrations');
  return coalesce((
    select jsonb_agg(to_jsonb(s))
    from public.list_integration_status() s
    where (s.owner_kind = 'artist' and s.owner_id = v_ctx.artist_id)
       or (s.owner_kind = 'workspace' and s.owner_id = v_ctx.workspace_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_calendar_connection_status()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'view_integrations');
  return coalesce((
    select jsonb_agg(to_jsonb(s)) from public.list_calendar_connection_status() s
    where s.artist_id = v_ctx.artist_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_reset_calendar_expected_account()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_integrations');
  return public.reset_calendar_expected_account(v_ctx.artist_id);
end;
$$;

-- Turns the active Artist's WhatsApp route on or off exactly as the CRM
-- switch does. The route key is the existing one, or the production key the
-- CRM derives from the Artist slug. Configuration stays empty: provider
-- account identity is bound by the Embedded Signup flow, never by the GPT.
create or replace function public.gpt_set_whatsapp_route_enabled(p_is_enabled boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ctx record;
  v_slug text;
  v_display text;
  v_key text;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_integrations');
  select a.slug, a.display_name into v_slug, v_display from public.artists a where a.id = v_ctx.artist_id;
  select i.integration_key into v_key
  from public.artist_integrations i
  where i.artist_id = v_ctx.artist_id and i.integration_type = 'whatsapp'
  order by i.updated_at desc
  limit 1;
  if v_key is null then
    if v_slug is null or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      raise exception 'the artist routing key is not valid for WhatsApp' using errcode = '22023';
    end if;
    v_key := v_slug || '-production';
  end if;
  return public.configure_artist_integration(v_ctx.artist_id, 'whatsapp', 'meta_cloud_api', v_key,
    v_display || ' WhatsApp', '{}'::jsonb, coalesce(p_is_enabled, false));
end;
$$;

create or replace function public.gpt_get_telegram_connector_info()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('integrations');
  return coalesce((select jsonb_agg(to_jsonb(t)) from public.get_telegram_connector_info() t), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_configure_telegram_bot_username(p_bot_username text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('integrations');
  return jsonb_build_object('bot_username', public.configure_telegram_connector_identity(p_bot_username));
end;
$$;

create or replace function public.gpt_list_telegram_destinations()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'view_integrations');
  return coalesce((
    select jsonb_agg(to_jsonb(d)) from public.list_telegram_destinations() d
    where d.artist_id is null or d.artist_id = v_ctx.artist_id
  ), '[]'::jsonb);
end;
$$;

-- p_destination_kind 'profile' is the signed-in person's own chat; 'artist'
-- is the active Artist's shared group.
create or replace function public.gpt_begin_telegram_link(p_destination_kind text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_integrations');
  if p_destination_kind = 'profile' then
    return public.begin_telegram_link('profile', null);
  elsif p_destination_kind = 'artist' then
    return public.begin_telegram_link('artist', v_ctx.artist_id);
  end if;
  raise exception 'Telegram destination kind must be profile or artist' using errcode = '22023';
end;
$$;

create or replace function public.gpt_disconnect_telegram_destination(p_destination_kind text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_done boolean;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_integrations');
  if p_destination_kind = 'profile' then
    v_done := public.disconnect_telegram_destination('profile', null);
  elsif p_destination_kind = 'artist' then
    v_done := public.disconnect_telegram_destination('artist', v_ctx.artist_id);
  else
    raise exception 'Telegram destination kind must be profile or artist' using errcode = '22023';
  end if;
  return jsonb_build_object('destination_kind', p_destination_kind, 'disconnected', v_done);
end;
$$;

create or replace function public.gpt_list_booking_sources()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'view_booking_sources');
  return coalesce((select jsonb_agg(to_jsonb(b)) from public.list_booking_sources(v_ctx.artist_id) b), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_create_booking_source(
  p_source_kind text,
  p_display_label text,
  p_allowed_origin text default null,
  p_form_template text default 'tattoo-enquiry',
  p_activate boolean default false
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_booking_sources');
  return jsonb_build_object('booking_source_id', public.create_booking_source(v_ctx.artist_id, p_source_kind,
    p_display_label, p_allowed_origin, coalesce(p_form_template, 'tattoo-enquiry'), coalesce(p_activate, false)));
end;
$$;

create or replace function public.gpt_update_booking_source(
  p_booking_source_id uuid,
  p_display_label text,
  p_allowed_origin text default null,
  p_is_active boolean default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_booking_sources');
  select b.artist_id into v_artist from public.booking_sources b where b.id = p_booking_source_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'booking source');
  return jsonb_build_object('booking_source_id', p_booking_source_id,
    'updated', public.update_booking_source(p_booking_source_id, p_display_label, p_allowed_origin, p_is_active));
end;
$$;

-- ------------------------------------------------------------------ Account
-- The signed-in person's own display name and language. No ceiling beyond read
-- access: these are the same self-service controls every CRM user has.

create or replace function public.gpt_get_account_overview()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('crm_read');
  return public.account_overview();
end;
$$;

create or replace function public.gpt_set_my_display_name(p_display_name text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('crm_read');
  return public.set_my_display_name(p_display_name);
end;
$$;

create or replace function public.gpt_set_my_language(p_language text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('crm_read');
  return jsonb_build_object('language', public.set_my_ui_language(p_language));
end;
$$;


-- --------------------------------------------------------------------- grants

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.gpt_list_integration_status()',
    'public.gpt_list_calendar_connection_status()',
    'public.gpt_reset_calendar_expected_account()',
    'public.gpt_set_whatsapp_route_enabled(boolean)',
    'public.gpt_get_telegram_connector_info()',
    'public.gpt_configure_telegram_bot_username(text)',
    'public.gpt_list_telegram_destinations()',
    'public.gpt_begin_telegram_link(text)',
    'public.gpt_disconnect_telegram_destination(text)',
    'public.gpt_list_booking_sources()',
    'public.gpt_create_booking_source(text,text,text,text,boolean)',
    'public.gpt_update_booking_source(uuid,text,text,boolean)',
    'public.gpt_get_account_overview()',
    'public.gpt_set_my_display_name(text)',
    'public.gpt_set_my_language(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
