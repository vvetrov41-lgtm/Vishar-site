-- 0052_whatsapp_integration_key_ownership.sql
--
-- Bind every WhatsApp integration selector to the artist that owns it.
--
-- `integration_key` is not a credential, but the Worker deterministically turns
-- it into the encrypted binding name. Without an ownership invariant a
-- privileged-but-misconfigured Vladimir row could point at a Kristina-prefixed
-- binding key. Provider routing would then faithfully resolve the wrong secret.
--
-- WhatsApp keys therefore live in the artist slug namespace:
--
--   vladimir-...
--   kristina-...
--
-- The suffix remains environment/purpose specific (`production`, `staging`,
-- `whatsapp`, `crm`, ...), so existing synthetic tests and the approved
-- production binding convention both remain valid. The database, not the UI,
-- is authoritative.
--
-- Forward-only. No integration row is created or enabled by this migration.

-- Refuse to install the stronger guard over pre-existing bad routing. A bad row
-- must be reviewed explicitly rather than silently grandfathered in.
do $$
begin
  if exists (
    select 1
    from public.artist_integrations i
    join public.artists a on a.id = i.artist_id
    where i.integration_type = 'whatsapp'::public.artist_integration_type
      and i.integration_key not like a.slug || '-%'
  ) then
    raise exception 'existing WhatsApp integration key is outside its artist namespace'
      using errcode = '23514';
  end if;
end;
$$;

-- Extend the existing identity/active-artist trigger instead of adding a
-- second public surface. Its existing ACL remains closed and is reasserted
-- below for defence in depth.
create or replace function crm_private.protect_artist_integration_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
begin
  if tg_op = 'UPDATE'
     and (
       new.artist_id is distinct from old.artist_id
       or new.integration_type is distinct from old.integration_type
       or new.integration_key is distinct from old.integration_key
     ) then
    raise exception 'artist integration identity is immutable; disable it and create a new integration'
      using errcode = '23514';
  end if;

  if new.integration_type = 'whatsapp'::public.artist_integration_type then
    select a.slug into v_artist_slug
    from public.artists a
    where a.id = new.artist_id;

    if not found then
      raise exception 'artist does not exist'
        using errcode = '23503';
    end if;

    if new.integration_key not like v_artist_slug || '-%' then
      raise exception 'WhatsApp integration key must stay in the owning artist namespace'
        using errcode = '23514';
    end if;
  end if;

  if new.is_enabled then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

revoke all on function crm_private.protect_artist_integration_identity()
  from public, anon, authenticated, service_role;

comment on function crm_private.protect_artist_integration_identity() is
  'Protects immutable artist integration identity, active-artist activation, and WhatsApp integration-key ownership. WhatsApp selectors must stay inside the owning artist slug namespace so one artist cannot resolve another artist encrypted binding.';
