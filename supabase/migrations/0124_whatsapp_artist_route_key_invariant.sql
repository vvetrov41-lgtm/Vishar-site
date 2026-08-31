-- WhatsApp route keys are security-sensitive because they deterministically map
-- to encrypted Cloudflare Worker bindings. Keep the artist slug and route key
-- inseparable at the database boundary, even if a caller bypasses the CRM UI.

create or replace function crm_private.enforce_whatsapp_artist_route_key()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_slug text;
begin
  if new.integration_type <> 'whatsapp' then
    return new;
  end if;

  select a.slug
    into v_slug
    from public.artists a
   where a.id = new.artist_id;

  if v_slug is null then
    raise exception 'WhatsApp artist route requires an existing artist'
      using errcode = '23503';
  end if;

  if new.integration_key not in (v_slug || '-production', v_slug || '-staging') then
    raise exception 'WhatsApp integration key must match the artist slug and environment'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.enforce_whatsapp_artist_route_key() from public;
revoke all on function crm_private.enforce_whatsapp_artist_route_key() from anon;
revoke all on function crm_private.enforce_whatsapp_artist_route_key() from authenticated;

-- Fail the migration before installing the trigger if historical data has
-- drifted. No route is silently rewritten in production.
do $$
begin
  if exists (
    select 1
      from public.artist_integrations ai
      join public.artists a on a.id = ai.artist_id
     where ai.integration_type = 'whatsapp'
       and ai.integration_key not in (a.slug || '-production', a.slug || '-staging')
  ) then
    raise exception 'Existing WhatsApp route key does not match its artist slug';
  end if;
end;
$$;

drop trigger if exists artist_integrations_whatsapp_route_key_guard
  on public.artist_integrations;

create trigger artist_integrations_whatsapp_route_key_guard
before insert or update of artist_id, integration_type, integration_key
on public.artist_integrations
for each row
execute function crm_private.enforce_whatsapp_artist_route_key();
