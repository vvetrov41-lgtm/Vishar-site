-- 0107_lifecycle_template_versioning.sql
--
-- Make lifecycle message-template versions truthful and immutable. Each save
-- remains a new draft row, but its version now advances inside the exact
-- workspace/artist + purpose + channel + locale slot. Transaction-scoped
-- advisory locking serialises even the first two concurrent saves, while the
-- partial unique indexes are the final database invariant.

alter table public.message_templates
  add constraint message_templates_version_positive
  check (version >= 1) not valid;

alter table public.message_templates
  validate constraint message_templates_version_positive;

create unique index message_templates_workspace_version_idx
  on public.message_templates (workspace_id, purpose, channel, locale, version)
  where artist_id is null;

create unique index message_templates_artist_version_idx
  on public.message_templates (artist_id, purpose, channel, locale, version)
  where artist_id is not null;

create or replace function public.upsert_message_template(
  p_workspace_id uuid,
  p_purpose text,
  p_channel public.message_template_channel,
  p_body text,
  p_locale text default 'en',
  p_subject text default null,
  p_artist_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_locale text := coalesce(p_locale, 'en');
  v_version integer;
  v_slot_key text;
begin
  -- An artist template is the artist's to write; a workspace template is the
  -- organisation's. Neither borrows the other's authority.
  if p_artist_id is not null then
    perform crm_private.require_artist_access(p_artist_id, 'manage_automations');
  else
    perform crm_private.require_workspace_access(p_workspace_id, 'manage_workspace');
  end if;

  if not exists (
    select 1 from public.message_template_purposes p where p.purpose = p_purpose
  ) then
    raise exception 'unknown message purpose %', p_purpose using errcode = '22023';
  end if;

  -- A row lock cannot serialise the first insert into an empty slot. This
  -- transaction-scoped lock covers that case without leaving persistent lock
  -- state. The unique indexes below remain authoritative if a collision is
  -- ever attempted outside this function.
  v_slot_key := concat_ws(
    '|',
    p_workspace_id::text,
    coalesce(p_artist_id::text, 'workspace'),
    p_purpose,
    p_channel::text,
    v_locale
  );
  perform pg_advisory_xact_lock(hashtextextended(v_slot_key, 0));

  select coalesce(max(t.version), 0) + 1
  into v_version
  from public.message_templates t
  where t.workspace_id = p_workspace_id
    and t.artist_id is not distinct from p_artist_id
    and t.purpose = p_purpose
    and t.channel = p_channel
    and t.locale = v_locale;

  insert into public.message_templates (
    workspace_id, artist_id, purpose, channel, locale, version,
    subject, body, status, created_by
  ) values (
    p_workspace_id, p_artist_id, p_purpose, p_channel, v_locale, v_version,
    p_subject, p_body, 'draft', auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_message_template(
  uuid, text, public.message_template_channel, text, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.upsert_message_template(
  uuid, text, public.message_template_channel, text, text, text, uuid
) to authenticated;

comment on function public.upsert_message_template(
  uuid, text, public.message_template_channel, text, text, text, uuid
) is
  'Creates one immutable draft at the next serialized version in an exact workspace/artist template slot.';
