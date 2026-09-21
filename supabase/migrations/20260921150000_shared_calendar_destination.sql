-- 20260921150000_shared_calendar_destination.sql
--
-- Project Vladimir and Kristina CRM calendar events into the shared studio
-- calendar while keeping separate Google OAuth accounts and artist routing.
-- The browser cannot select this destination: it remains server-owned metadata.
--
-- Rollout order is Worker first, database second. The Worker revision accepting
-- non-primary trusted targets is backwards-compatible with the current primary
-- configuration, while applying this migration to the old Worker would fail
-- closed with provider_route_invalid.

create or replace function public.set_calendar_connection_metadata(
  p_artist_id uuid,
  p_integration_key text,
  p_external_account_label text,
  p_is_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
  v_external_account_label text;
  v_existing_label text;
  v_existing_configuration jsonb;
  v_calendar_id text;
  v_destination_event_label_id text;
  v_presentation jsonb;
  v_integration_id uuid;
  v_reconciled integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar connection metadata is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null or p_is_enabled is null then
    raise exception 'calendar connection metadata is incomplete'
      using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  select a.slug
  into v_artist_slug
  from public.artists a
  where a.id = p_artist_id
    and a.is_active;

  if v_artist_slug is null then
    raise exception 'calendar artist is not active'
      using errcode = '55000';
  end if;

  if p_integration_key is distinct from ('google_calendar_' || v_artist_slug) then
    raise exception 'calendar integration key does not match artist route'
      using errcode = '22023';
  end if;

  v_external_account_label := lower(btrim(coalesce(p_external_account_label, '')));
  if v_external_account_label = ''
     or length(v_external_account_label) > 160
     or v_external_account_label !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'calendar account label is invalid'
      using errcode = '22023';
  end if;

  select i.external_account_label, i.configuration
    into v_existing_label, v_existing_configuration
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'calendar'::public.artist_integration_type
    and i.integration_key = 'google_calendar_' || v_artist_slug;

  v_calendar_id := nullif(btrim(coalesce(v_existing_configuration ->> 'calendar_id', '')), '');
  if (
    v_calendar_id is null
    or char_length(v_calendar_id) > 1024
    or v_calendar_id ~ '[[:space:][:cntrl:]]'
  ) then
    v_calendar_id := 'primary';
  end if;

  v_destination_event_label_id := lower(nullif(
    btrim(coalesce(v_existing_configuration ->> 'destination_event_label_id', '')),
    ''
  ));
  if v_destination_event_label_id is not null
     and v_destination_event_label_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_destination_event_label_id := null;
  end if;

  if v_existing_label is not null
     and lower(btrim(v_existing_label)) is distinct from v_external_account_label then
    raise exception 'calendar account is already bound to a different Google account'
      using errcode = '23505',
            detail = 'Disconnect and clear the recorded account before binding a different one.';
  end if;

  if exists (
    select 1
    from public.artist_integrations i
    where i.integration_type = 'calendar'::public.artist_integration_type
      and i.artist_id <> p_artist_id
      and lower(btrim(i.external_account_label)) = v_external_account_label
  ) then
    raise exception 'calendar account is already bound to another artist'
      using errcode = '23505';
  end if;

  v_presentation := crm_private.normalized_calendar_presentation(
    p_artist_id,
    v_existing_configuration -> 'presentation'
  );

  insert into public.artist_integrations (
    artist_id,
    integration_type,
    provider,
    integration_key,
    external_account_label,
    configuration,
    is_enabled
  ) values (
    p_artist_id,
    'calendar',
    'google',
    'google_calendar_' || v_artist_slug,
    v_external_account_label,
    jsonb_build_object(
      'calendar_id', v_calendar_id,
      'destination_event_label_id', v_destination_event_label_id,
      'oauth_scope', 'calendar.events',
      'connection_mode', 'worker_oauth',
      'artist_slug', v_artist_slug,
      'presentation', v_presentation
    ),
    p_is_enabled
  )
  on conflict (artist_id, integration_type, integration_key) do update
    set provider = 'google',
        external_account_label = excluded.external_account_label,
        configuration = excluded.configuration,
        is_enabled = excluded.is_enabled,
        updated_at = now()
  returning id into v_integration_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    case
      when p_is_enabled then 'integration.calendar_connected'
      else 'integration.calendar_disconnected'
    end,
    'worker',
    null,
    null,
    null,
    null,
    null,
    null,
    jsonb_build_object(
      'integration_type', 'calendar',
      'provider', 'google',
      'integration_key', 'google_calendar_' || v_artist_slug,
      'is_enabled', p_is_enabled
    )
  );

  -- Reconnecting re-queues Time Off blocks that never reached Google, exactly
  -- as migration 0041 established. Losing this would silently drop the
  -- recovery path for every artist.
  if p_is_enabled then
    v_reconciled := crm_private.reconcile_artist_availability_calendar(p_artist_id);
  end if;

  return jsonb_build_object(
    'integration_id', v_integration_id,
    'artist_id', p_artist_id,
    'artist_slug', v_artist_slug,
    'provider', 'google',
    'integration_key', 'google_calendar_' || v_artist_slug,
    'is_enabled', p_is_enabled,
    'reconciled_availability_jobs', v_reconciled
  );
end;
$$;

revoke all on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  to service_role;

comment on function public.set_calendar_connection_metadata(uuid,text,text,boolean) is
  'Backend-only Google Calendar connection metadata upsert for any active artist. The route selector is derived from the artist slug, the Google account is pinned on first connect, and no token material is accepted or returned.';



-- The two current studio artists share one destination calendar, while their
-- OAuth account pins remain separate. Preserve updated_at so this routing
-- migration is not presented as a reconnect.
update public.artist_integrations i
set configuration = jsonb_set(
      coalesce(i.configuration, '{}'::jsonb),
      '{calendar_id}',
      to_jsonb('info@labeltattooprivate.co.uk'::text),
      true
    ),
    updated_at = i.updated_at
from public.artists a
where a.id = i.artist_id
  and i.integration_type = 'calendar'::public.artist_integration_type
  and i.provider = 'google'
  and a.slug in ('vladimir', 'kristina');

-- Wisteria label ids are calendar-specific. This is the verified Wisteria label
-- on the shared studio calendar, so the drain must prefer it over the label id
-- cached from Kristina's personal primary calendar during OAuth consent.
update public.artist_integrations i
set configuration = jsonb_set(
      coalesce(i.configuration, '{}'::jsonb),
      '{destination_event_label_id}',
      to_jsonb('bfbf0ae9-bf7f-4035-9e96-b66cbf2648df'::text),
      true
    ),
    updated_at = i.updated_at
from public.artists a
where a.id = i.artist_id
  and i.integration_type = 'calendar'::public.artist_integration_type
  and i.provider = 'google'
  and a.slug = 'kristina';

comment on function public.set_calendar_connection_metadata(uuid,text,text,boolean) is
  'Backend-only Google Calendar connection metadata upsert. It pins the Google OAuth account, preserves the server-owned destination calendar and destination-specific event label id across reconnects, and accepts no token material.';
