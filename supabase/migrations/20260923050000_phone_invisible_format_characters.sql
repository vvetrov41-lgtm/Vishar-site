-- 20260923050000_phone_invisible_format_characters.sql
--
-- Audit M-3 follow-up. Phones pasted from a phone's contact card can carry
-- invisible Unicode format characters (for example U+202C POP DIRECTIONAL
-- FORMATTING at the end). They are not part of the number, but they make
-- every normaliser reject it, so a UK number with explicit London evidence
-- stayed unresolved in production. Stripping only these zero-width and bidi
-- control characters is a formatting fix, never a guess: the digits and any
-- country code are untouched, and the value as entered is still kept in
-- clients.phone_input.

create function crm_private.strip_invisible_format(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select regexp_replace(
    p_value,
    '[' || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238)
        || chr(8288) || '-' || chr(8292) || chr(65279) || ']',
    '', 'g'
  );
$$;

revoke all on function crm_private.strip_invisible_format(text) from public, anon, authenticated, service_role;

create or replace function crm_private.client_phone_e164(p_phone text, p_travelling_from text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(
    public.normalize_phone(crm_private.strip_invisible_format(p_phone)),
    crm_private.normalize_local_phone(
      crm_private.strip_invisible_format(p_phone),
      crm_private.country_from_location(p_travelling_from)
    )
  );
$$;

create or replace function crm_private.normalize_client_local_phone()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_clean text;
  v_country text;
  v_e164 text;
begin
  if new.phone is null or public.normalize_phone(new.phone) is not null then
    return new;
  end if;
  v_clean := crm_private.strip_invisible_format(new.phone);

  -- Already international once invisible characters are removed: store the
  -- clean value; no country evidence was needed.
  if public.normalize_phone(v_clean) is not null then
    if not exists (
      select 1 from public.clients x
      where x.phone_normalized = public.normalize_phone(v_clean)
        and x.id <> new.id
        and x.workspace_id is not distinct from new.workspace_id
    ) then
      new.phone_input := new.phone;
      new.phone := v_clean;
    end if;
    return new;
  end if;

  v_country := crm_private.country_from_location(new.travelling_from);
  v_e164 := crm_private.normalize_local_phone(v_clean, v_country);
  if v_e164 is null then
    return new;
  end if;
  if exists (
    select 1 from public.clients x
    where x.phone_normalized = v_e164
      and x.id <> new.id
      and x.workspace_id is not distinct from new.workspace_id
  ) then
    return new;
  end if;
  new.phone_input := new.phone;
  new.phone := v_e164;
  new.phone_normalization_basis := 'travelling_from:' || v_country;
  return new;
end;
$$;

-- Backfill only rows the cleanup now resolves.
with converted as (
  update public.clients c
  set phone = c.phone
  where c.phone_normalized is null
    and c.phone is not null
    and crm_private.strip_invisible_format(c.phone) <> c.phone
    and crm_private.client_phone_e164(c.phone, c.travelling_from) is not null
  returning c.id, c.phone_normalization_basis
)
select crm_private.log_activity(
  'client.phone_country_normalized', 'system', null, converted.id,
  null, null, null, null, null, null, null,
  jsonb_build_object('basis', coalesce(converted.phone_normalization_basis, 'format_cleanup'), 'audit', 'M-3')
)
from converted;
