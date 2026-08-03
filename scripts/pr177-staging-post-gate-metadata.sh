#!/usr/bin/env bash
set -euo pipefail

# Post-gate metadata setup for retained PR #177 staging only.
# This script never targets production and never prints credential values.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly BOOKING_ORIGIN="https://vishar-booking-staging.pages.dev"
readonly SOURCE_KEY="vladimir-staging"
readonly FORM_VERSION="booking-v1"
readonly VLADIMIR_ID="a1111111-1111-4111-8111-111111111111"
readonly KRISTINA_ID="a2222222-2222-4222-8222-222222222222"
readonly ROUTE_KEY="vladimir-staging"

evidence_dir="${RUNNER_TEMP:?}/pr177-staging-evidence"
mkdir -p "$evidence_dir"

[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || {
  echo 'required encrypted secret SUPABASE_ACCESS_TOKEN is unavailable' >&2
  exit 1
}

sql_file="${RUNNER_TEMP}/pr177-post-gate-metadata.sql"
request_file="${RUNNER_TEMP}/pr177-post-gate-metadata.json"
response_file="${evidence_dir}/routing-metadata.json"

cat > "$sql_file" <<SQL
insert into public.booking_sources
  (artist_id, source_key, allowed_origin, form_version, is_active)
values
  ('$VLADIMIR_ID', '$SOURCE_KEY', '$BOOKING_ORIGIN', '$FORM_VERSION', true)
on conflict (source_key) do update
set artist_id = excluded.artist_id,
    allowed_origin = excluded.allowed_origin,
    form_version = excluded.form_version,
    is_active = excluded.is_active;

do \$block\$
declare
  v_owner uuid;
begin
  select p.id into v_owner
  from public.profiles p
  where p.role = 'owner' and p.is_active
  order by p.id
  limit 1;

  if v_owner is null then
    raise exception 'active owner profile required';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  perform public.configure_artist_integration(
    '$VLADIMIR_ID',
    'telegram',
    'telegram',
    '$ROUTE_KEY',
    'Vishar CRM Staging',
    '{"environment":"staging","routing":"artist-specific"}'::jsonb,
    true
  );
end
\$block\$;

do \$block\$
begin
  if not exists (
    select 1
    from public.booking_sources
    where source_key = '$SOURCE_KEY'
      and artist_id = '$VLADIMIR_ID'
      and allowed_origin = '$BOOKING_ORIGIN'
      and form_version = '$FORM_VERSION'
      and is_active
  ) then
    raise exception 'trusted booking source mismatch';
  end if;

  if not exists (
    select 1
    from public.artist_integrations
    where artist_id = '$VLADIMIR_ID'
      and integration_type = 'telegram'
      and provider = 'telegram'
      and integration_key = '$ROUTE_KEY'
      and is_enabled
      and configuration = '{"environment":"staging","routing":"artist-specific"}'::jsonb
  ) then
    raise exception 'artist Telegram metadata mismatch';
  end if;

  if exists (
    select 1
    from public.artist_integrations
    where artist_id = '$KRISTINA_ID'
      and integration_type = 'telegram'
      and is_enabled
  ) then
    raise exception 'Kristina must have no enabled staging Telegram route';
  end if;
end
\$block\$;

select jsonb_build_object(
  'source_key', s.source_key,
  'origin', s.allowed_origin,
  'form_version', s.form_version,
  'artist_slug', a.slug,
  'integration_type', i.integration_type,
  'provider', i.provider,
  'integration_key', i.integration_key,
  'external_account_label', i.external_account_label,
  'configuration', i.configuration
) as metadata
from public.booking_sources s
join public.artists a on a.id = s.artist_id
join public.artist_integrations i
  on i.artist_id = s.artist_id
 and i.integration_type = 'telegram'
 and i.is_enabled
where s.source_key = '$SOURCE_KEY';
SQL

jq -Rs '{query: .}' < "$sql_file" > "$request_file"
http_status="$(
  curl --silent --show-error \
    -o "$response_file" \
    -w '%{http_code}' \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"
)"

rm -f "$request_file" "$sql_file"

if [ "$http_status" != 200 ]; then
  jq -r '(.message // .error // "hosted metadata SQL failed") | tostring' "$response_file" >&2 || true
  exit 1
fi

jq -e '
  if type == "array" then
    length > 0
  else
    ((.error // null) == null and (.result // null) != null)
  end
' "$response_file" >/dev/null

# Evidence contains only safe route metadata; no secret value is selected.
jq -S . "$response_file" > "${response_file}.sorted"
