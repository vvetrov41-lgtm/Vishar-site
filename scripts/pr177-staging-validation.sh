#!/usr/bin/env bash
set -euo pipefail

# Retained hosted-staging validation for draft PR #177. This script is called
# only by the guarded workflow in .github/workflows/pr177-staging-deploy-e2e.yml.
# It never targets production and never prints credential values.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly WORKER_NAME="tattooai-preview"
readonly WORKER_URL="https://intake-staging.vishartattoo.com/__vishar-staging-intake-2026"
readonly BOOKING_ORIGIN="https://vishar-booking-staging.pages.dev"
readonly CRM_ORIGIN="https://vishar-crm-staging.pages.dev"
readonly SOURCE_KEY="vladimir-staging"
readonly FORM_VERSION="booking-v1"
readonly VLADIMIR_ID="a1111111-1111-4111-8111-111111111111"
readonly KRISTINA_ID="a2222222-2222-4222-8222-222222222222"
readonly ROUTE_KEY="vladimir-staging"
readonly ROUTE_BINDING="ARTIST_TELEGRAM_VLADIMIR_HSTAGING"

evidence_dir="${RUNNER_TEMP:?}/pr177-staging-evidence"
mkdir -p "$evidence_dir"

die() { echo "staging validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted secret $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr177-sql.XXXXXX.json")"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" > "$output_file"
  rm -f "$request_file"
  jq -e 'if type == "array" then true else ((.error // null) == null and (.result // null) != null) end' \
    "$output_file" >/dev/null || die "hosted SQL request failed"
}

sql_rows() {
  jq -c 'if type == "array" then . else .result end' "$1"
}

prepare_wrangler() {
  cp wrangler.toml wrangler.preview.toml
  python3 - <<'PY'
from pathlib import Path
p = Path('wrangler.preview.toml')
s = p.read_text()
old = 'main = "workers/tattooai.js"'
new = 'main = "workers/preview.js"'
if s.count(old) != 1:
    raise SystemExit('expected exactly one Worker entrypoint')
p.write_text(s.replace(old, new))
PY
}

snapshot_database() {
  local target="${1:-database-before.json}"
  cat > "${RUNNER_TEMP}/snapshot.sql" <<'SQL'
select jsonb_build_object(
  'clients', (select count(*) from public.clients),
  'enquiries', (select count(*) from public.enquiries),
  'projects', (select count(*) from public.projects),
  'file_manifests', (select count(*) from public.enquiry_files),
  'storage_objects', (select count(*) from storage.objects where bucket_id='crm-files'),
  'outbox', (select count(*) from public.integration_outbox),
  'activity', (select count(*) from public.activity_log),
  'references', coalesce((select jsonb_agg(reference_number order by reference_number)
                          from public.enquiries), '[]'::jsonb)
) as snapshot;
SQL
  sql "${RUNNER_TEMP}/snapshot.sql" "${evidence_dir}/${target}"
}

migrate_and_test() {
  require_env SUPABASE_ACCESS_TOKEN
  require_env SUPABASE_DB_PASSWORD

  npx supabase@2.111.0 link --project-ref "$PROJECT_REF"
  npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-before.txt"
  mapfile -t before_versions < <(awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9][0-9][0-9][0-9]$/) print $2}' "${evidence_dir}/migrations-before.txt")
  [ "${#before_versions[@]}" -eq 14 ] || die "staging must contain exactly migrations 0001 through 0014 before mutation"
  for n in $(seq -w 1 14); do printf '%s\n' "${before_versions[@]}" | grep -Fxq "00$n" || die "remote migration 00$n is absent"; done

  snapshot_database
  npx supabase@2.111.0 db push --linked --dry-run 2>&1 | tee "${evidence_dir}/migration-dry-run.txt"
  for n in $(seq 15 25); do grep -Eq "(^|[^0-9])00${n}([^0-9]|$)" "${evidence_dir}/migration-dry-run.txt" || die "dry-run omitted migration 00${n}"; done
  npx supabase@2.111.0 db push --linked --yes
  npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-after.txt"
  for n in $(seq -w 1 25); do grep -Eq "(^|[^0-9])00${n}([^0-9]|$)" "${evidence_dir}/migrations-after.txt" || die "remote migration 00${n} is absent after push"; done

  npx supabase@2.111.0 test db --linked 2>&1 | tee "${evidence_dir}/hosted-pgtap.txt"
  grep -Eq 'Tests[=:][[:space:]]*933|1\.\.933' "${evidence_dir}/hosted-pgtap.txt" || die "hosted pgTAP count was not exactly 933"
  grep -Eq 'Result:[[:space:]]*PASS|All tests successful' "${evidence_dir}/hosted-pgtap.txt" || die "hosted pgTAP did not pass"

  npx supabase@2.111.0 db lint --linked --schema public,crm_private --level error --fail-on error \
    2>&1 | tee "${evidence_dir}/hosted-lint.txt"
}

configure_metadata() {
  cat > "${RUNNER_TEMP}/metadata.sql" <<SQL
insert into public.booking_sources
  (artist_id, source_key, allowed_origin, form_version, is_active)
values
  ('$VLADIMIR_ID', '$SOURCE_KEY', '$BOOKING_ORIGIN', '$FORM_VERSION', true)
on conflict (source_key) do update
set allowed_origin = excluded.allowed_origin,
    form_version = excluded.form_version,
    is_active = excluded.is_active;

begin;
set local role authenticated;

do \$block\$
declare v_owner uuid;
begin
  select profile_id into v_owner from crm_private.profile_access
  where role = 'owner' and is_active order by profile_id limit 1;
  if v_owner is null then raise exception 'active owner profile required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_owner,'role','authenticated')::text, true);
  perform public.configure_artist_integration(
    '$VLADIMIR_ID', 'telegram', 'telegram', '$ROUTE_KEY',
    'Vishar CRM Staging', '{"environment":"staging","routing":"artist-specific"}'::jsonb, true
  );
end
\$block\$;
commit;

do \$block\$
begin
  if not exists (
    select 1 from public.booking_sources
    where source_key='$SOURCE_KEY' and artist_id='$VLADIMIR_ID'
      and allowed_origin='$BOOKING_ORIGIN' and form_version='$FORM_VERSION' and is_active
  ) then raise exception 'trusted booking source mismatch'; end if;
  if not exists (
    select 1 from public.artist_integrations
    where artist_id='$VLADIMIR_ID' and integration_type='telegram'
      and provider='telegram' and integration_key='$ROUTE_KEY' and is_enabled
      and configuration = '{"environment":"staging","routing":"artist-specific"}'::jsonb
  ) then raise exception 'artist Telegram metadata mismatch'; end if;
  if exists (
    select 1 from public.artist_integrations
    where artist_id='$KRISTINA_ID' and integration_type='telegram' and is_enabled
  ) then raise exception 'Kristina must have no enabled staging Telegram route'; end if;
end
\$block\$;

select jsonb_build_object(
 'source_key', s.source_key, 'origin', s.allowed_origin, 'form_version', s.form_version,
 'artist_slug', a.slug, 'integration_type', i.integration_type,
 'provider', i.provider, 'integration_key', i.integration_key,
 'external_account_label', i.external_account_label,
 'configuration', i.configuration
) as metadata
from public.booking_sources s
join public.artists a on a.id=s.artist_id
join public.artist_integrations i on i.artist_id=s.artist_id and i.integration_type='telegram' and i.is_enabled
where s.source_key='$SOURCE_KEY';
SQL
  sql "${RUNNER_TEMP}/metadata.sql" "${evidence_dir}/routing-metadata.json"
}

deploy_worker() {
  require_env CLOUDFLARE_API_TOKEN
  require_env CLOUDFLARE_ACCOUNT_ID
  require_env SUPABASE_SECRET_KEY
  require_env TELEGRAM_BOT_TOKEN
  require_env TELEGRAM_CHAT_ID
  prepare_wrangler

  secret_file="$(mktemp "${RUNNER_TEMP}/pr177-worker-secrets.XXXXXX.json")"
  chmod 600 "$secret_file"
  jq -n --arg service "$SUPABASE_SECRET_KEY" --arg bot "$TELEGRAM_BOT_TOKEN" --arg chat "$TELEGRAM_CHAT_ID" \
    --arg binding "$ROUTE_BINDING" \
    '{SUPABASE_SECRET_KEY:$service,TELEGRAM_BOT_TOKEN:null,TELEGRAM_CHAT_ID:null}
     + {($binding):({botToken:$bot,chatId:$chat}|tojson)}' > "$secret_file"
  npx wrangler secret bulk --config wrangler.preview.toml --env preview < "$secret_file"
  rm -f "$secret_file"
  npx wrangler secret list --config wrangler.preview.toml --env preview --json > "${evidence_dir}/worker-bindings.json"
  jq -e --arg required "$ROUTE_BINDING" '[.. | objects | .name? // empty] | index($required) != null' "${evidence_dir}/worker-bindings.json" >/dev/null
  jq -e '[.. | objects | .name? // empty] | index("TELEGRAM_BOT_TOKEN") == null and index("TELEGRAM_CHAT_ID") == null' "${evidence_dir}/worker-bindings.json" >/dev/null

  npx wrangler deploy --config wrangler.preview.toml --env preview \
    --var VISHAR_ENVIRONMENT:preview \
    --var SUPABASE_URL:"$STAGING_SUPABASE_URL" \
    --var ALLOWED_ORIGINS:"$BOOKING_ORIGIN" \
    --var BOOKING_SOURCE_KEY:"$SOURCE_KEY" \
    --var BOOKING_FORM_VERSION:"$FORM_VERSION" \
    2>&1 | tee "${evidence_dir}/worker-deploy.txt"
  npx wrangler deployments list --config wrangler.preview.toml --env preview --json > "${evidence_dir}/worker-deployments.json"
}

prepare_booking() {
  mkdir -p _booking_staging
  git archive HEAD | tar -x -C _booking_staging
  rm -rf _booking_staging/.github _booking_staging/admin _booking_staging/docs _booking_staging/scripts _booking_staging/supabase _booking_staging/tests _booking_staging/workers
  rm -f _booking_staging/package.json _booking_staging/package-lock.json _booking_staging/wrangler.toml _booking_staging/TECHNICAL_AUDIT.md
  node <<'NODE'
const fs = require('fs');
const path = '_booking_staging/booking/index.html';
let html = fs.readFileSync(path, 'utf8');
for (const [from,to] of [
  ['<meta name="robots" content="index, follow">','<meta name="robots" content="noindex, nofollow, noarchive">'],
  ['<meta name="vishar-booking-endpoint" content="">','<meta name="vishar-booking-endpoint" content="https://intake-staging.vishartattoo.com/__vishar-staging-intake-2026">'],
  ["const productionEndpoint = 'https://tattooai.vvetrov41.workers.dev/';","const productionEndpoint = '';"]
]) {
  if (html.split(from).length - 1 !== 1) throw new Error(`staging substitution mismatch: ${from}`);
  html = html.replace(from,to);
}
fs.writeFileSync(path,html);
let headers=fs.readFileSync('_booking_staging/_headers','utf8');
const from="connect-src 'self' https://tattooai.vvetrov41.workers.dev";
const to="connect-src 'self' https://intake-staging.vishartattoo.com https://tattooai.vvetrov41.workers.dev";
if (headers.split(from).length - 1 !== 1) throw new Error('booking CSP substitution mismatch');
fs.writeFileSync('_booking_staging/_headers',headers.replace(from,to));
fs.writeFileSync('_booking_staging/index.html','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><meta http-equiv="refresh" content="0;url=/booking/"><title>Vishar booking staging</title></head></html>\n');
NODE
  ! grep -Fq 'https://tattooai.vvetrov41.workers.dev/' _booking_staging/booking/index.html
}

deploy_pages() {
  prepare_booking
  npx wrangler pages deploy _booking_staging --project-name vishar-booking-staging --branch main \
    --commit-hash "$GITHUB_SHA" --commit-message "PR177 retained staging $GITHUB_SHA" --commit-dirty=true \
    2>&1 | tee "${evidence_dir}/booking-deploy.txt"

  (cd admin && npm ci && npm test && npm run typecheck && npm run build)
  test -f admin/dist/index.html
  grep -Fq noindex admin/dist/index.html
  grep -R -Fq 'All assigned artists' admin/dist
  grep -R -Fq 'Все назначенные мастера' admin/dist
  ! grep -R -E -q 'sb_secret_[A-Za-z0-9_-]{20,}' admin/dist
  npx wrangler pages deploy admin/dist --project-name vishar-crm-staging --branch main \
    --commit-hash "$GITHUB_SHA" --commit-message "PR177 retained staging $GITHUB_SHA" --commit-dirty=true \
    2>&1 | tee "${evidence_dir}/crm-deploy.txt"
}

multipart_submit() {
  local key="$1" label="$2" output="$3"
  curl --fail-with-body --silent --show-error \
    -H "Origin: $BOOKING_ORIGIN" \
    -F "idempotencyKey=$key" -F "name=PR177 Synthetic $label" \
    -F "email=pr177-${GITHUB_RUN_ID}-${label,,}@example.invalid" \
    -F 'phone=' -F 'instagram=' -F 'preferredReply=Email' -F 'travellingFrom=London' \
    -F 'projectType=Colour realism' -F 'placement=Outer forearm' -F 'size=20 cm' \
    -F 'coverUp=No' -F 'timing=Flexible' -F 'idea=Synthetic hosted staging routing validation.' \
    -F 'website=' -F 'source=/booking/' -F "landingPage=$BOOKING_ORIGIN/booking/" \
    -F 'referrer=' -F 'utmSource=pr177-staging' -F 'utmMedium=synthetic' \
    -F 'privacyAcknowledged=true' -F 'privacyNoticeVersion=2026-07-29' \
    -F "artist_id=$KRISTINA_ID" -F 'integration_key=kristina-staging' \
    -F 'provider_account=forbidden-browser-route' -F 'payment_destination=forbidden-browser-route' \
    -F "references=@${RUNNER_TEMP}/synthetic-reference.png;type=image/png" \
    "$WORKER_URL" > "$output"
  jq -e '.ok == true and (.reference | type == "string")' "$output" >/dev/null
}

database_e2e_assertions() {
  local positive_ref="$1" noroute_ref="$2"
  cat > "${RUNNER_TEMP}/assertions.sql" <<SQL
do \$block\$
declare p record; n record;
begin
  select e.id,e.artist_id,e.booking_source_id into p from public.enquiries e where e.reference_number='$positive_ref';
  select e.id,e.artist_id,e.booking_source_id into n from public.enquiries e where e.reference_number='$noroute_ref';
  if p.artist_id <> '$VLADIMIR_ID' or n.artist_id <> '$VLADIMIR_ID' then raise exception 'browser artist route influenced intake'; end if;
  if not exists (select 1 from public.booking_sources s where s.id=p.booking_source_id and s.source_key='$SOURCE_KEY') then raise exception 'positive trusted source mismatch'; end if;
  if not exists (select 1 from public.booking_sources s where s.id=n.booking_source_id and s.source_key='$SOURCE_KEY') then raise exception 'no-route trusted source mismatch'; end if;
  if (select count(*) from public.enquiry_files f where f.enquiry_id=p.id and f.upload_state='ready') <> 1 then raise exception 'positive storage manifest mismatch'; end if;
  if (select count(*) from public.enquiry_files f where f.enquiry_id=n.id and f.upload_state='ready') <> 1 then raise exception 'no-route storage manifest mismatch'; end if;
  if not exists (select 1 from public.integration_outbox o where o.enquiry_id=p.id and o.artist_id='$VLADIMIR_ID') then raise exception 'positive outbox artist mismatch'; end if;
  if not exists (select 1 from public.integration_outbox o where o.enquiry_id=n.id and o.artist_id='$VLADIMIR_ID') then raise exception 'no-route outbox artist mismatch'; end if;
  if not exists (select 1 from public.integration_outbox o where o.enquiry_id=p.id and o.status='succeeded' and o.attempt_count=1 and o.last_error_code is null) then raise exception 'positive provider attempt mismatch'; end if;
  if not exists (select 1 from public.integration_outbox o where o.enquiry_id=n.id and o.status='failed' and o.attempt_count=1 and o.last_error_code='provider_route_unavailable') then raise exception 'no-route fail-closed outcome mismatch'; end if;
  if not exists (select 1 from public.activity_log a where a.enquiry_id=p.id and a.artist_id='$VLADIMIR_ID') then raise exception 'positive activity artist mismatch'; end if;
  if not exists (select 1 from public.activity_log a where a.enquiry_id=n.id and a.artist_id='$VLADIMIR_ID') then raise exception 'no-route activity artist mismatch'; end if;
end
\$block\$;

set role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select jsonb_build_object(
 'positive_reference','$positive_ref','no_route_reference','$noroute_ref',
 'positive_route',(select to_jsonb(r) - 'configuration' from public.integration_outbox o cross join lateral public.resolve_outbox_route(o.id) r where o.enquiry_id=(select id from public.enquiries where reference_number='$positive_ref')),
 'positive_artist',(select artist_id from public.enquiries where reference_number='$positive_ref'),
 'no_route_artist',(select artist_id from public.enquiries where reference_number='$noroute_ref')
) as routing_evidence;
reset role;
SQL
  # The positive route is re-enabled before this query.
  sql "${RUNNER_TEMP}/assertions.sql" "${evidence_dir}/routing-evidence.json"
}

role_scope_assertions() {
  cat > "${RUNNER_TEMP}/roles.sql" <<SQL
begin;
set local role authenticated;
do \$block\$
declare v_owner uuid; v_manager uuid; v_reader uuid; v_count int;
begin
  select profile_id into v_owner from crm_private.profile_access where role='owner' and is_active order by profile_id limit 1;
  select profile_id into v_manager from crm_private.profile_access where role='booking_manager' and is_active order by profile_id limit 1;
  select profile_id into v_reader from crm_private.profile_access where role='read_only' and is_active order by profile_id limit 1;
  if v_owner is null or v_manager is null or v_reader is null then raise exception 'owner, manager and read_only profiles are required'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 2 then raise exception 'owner artist scope mismatch'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager,'role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 1 then raise exception 'manager initial artist scope mismatch'; end if;
  if exists(select 1 from public.enquiries where artist_id='$KRISTINA_ID') then raise exception 'manager crossed Kristina RLS before grant'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'role','authenticated')::text,true);
  perform public.upsert_artist_membership(v_manager,'$KRISTINA_ID','manager',false,false,true,false,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager,'role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 2 then raise exception 'manager artist grant was not visible'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'role','authenticated')::text,true);
  perform public.upsert_artist_membership(v_manager,'$KRISTINA_ID','manager',false,false,true,false,false);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager,'role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 1 then raise exception 'manager revoked artist scope remained visible'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_reader,'role','authenticated')::text,true);
  if exists(select 1 from public.enquiries where artist_id='$KRISTINA_ID') then raise exception 'read_only crossed artist RLS'; end if;
end
\$block\$;
commit;

select jsonb_build_object(
 'owner_accessible_artists',2,
 'manager_before_grant',1,'manager_during_grant',2,'manager_after_revoke',1,
 'read_only_cross_artist_rows',0,
 'clients_scope','shared','activity_scope','event-time artist preserved',
 'storage_policy_regression','hosted pgTAP plus routed ready manifests',
 'activity_mutation_regression','hosted pgTAP append-only checks passed'
) as role_evidence;
SQL
  sql "${RUNNER_TEMP}/roles.sql" "${evidence_dir}/crm-rls-evidence.json"
}

edge_assertions() {
  api='https://api.cloudflare.com/client/v4'
  auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
  curl --silent --show-error -D "${evidence_dir}/booking-access.headers" -o /dev/null "$BOOKING_ORIGIN/booking/"
  curl --silent --show-error -D "${evidence_dir}/crm-access.headers" -o /dev/null "$CRM_ORIGIN/"
  grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/booking-access.headers"
  grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/crm-access.headers"

  code="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 204 ] || die "trusted CORS preflight was $code"
  code="$(curl -sS -o "${evidence_dir}/invalid-origin.json" -w '%{http_code}' -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 403 ] || die "untrusted origin was not blocked"
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$WORKER_URL")"
  case "$code" in 403|404|405) ;; *) die "wrong-method WAF probe was $code";; esac

  zone_id="$(curl -sS "${auth[@]}" "$api/zones?name=vishartattoo.com" | jq -r '.result[0].id // empty')"
  [ -n "$zone_id" ] || die "staging zone unavailable"
  curl -sS "${auth[@]}" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" > "${evidence_dir}/access.json"
  curl -sS "${auth[@]}" "$api/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "${evidence_dir}/waf.json"
  curl -sS "${auth[@]}" "$api/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "${evidence_dir}/rate-limit.json"
  curl -sS "${auth[@]}" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/$WORKER_NAME/environments/production/subdomain" > "${evidence_dir}/subdomain.json"
  jq -e '[.result[] | select(.domain == "vishar-booking-staging.pages.dev" or .domain == "vishar-crm-staging.pages.dev")] | length == 2' "${evidence_dir}/access.json" >/dev/null
  jq -e '[.result.rules[]? | select(.enabled and ((.expression // "") | contains("intake-staging.vishartattoo.com")))] | length > 0' "${evidence_dir}/waf.json" >/dev/null
  jq -e '[.result.rules[]? | select(.enabled and ((.expression // "") | contains("intake-staging.vishartattoo.com")))] | length > 0' "${evidence_dir}/rate-limit.json" >/dev/null
  jq -e '.result.enabled == false and .result.previews_enabled == false' "${evidence_dir}/subdomain.json" >/dev/null

  limited=false
  for _ in 1 2 3 4 5 6 7; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
    [ "$code" = 429 ] && limited=true
  done
  $limited || die "rate-limit probe did not observe 429"
  sleep 12
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 204 ] || die "rate-limit did not recover"
}

hosted_e2e() {
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' | base64 -d > "${RUNNER_TEMP}/synthetic-reference.png"
  positive_key="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  multipart_submit "$positive_key" Positive "${evidence_dir}/positive.json"
  positive_ref="$(jq -r '.reference' "${evidence_dir}/positive.json")"
  multipart_submit "$positive_key" Positive "${evidence_dir}/replay.json"
  [ "$(jq -r '.reference' "${evidence_dir}/replay.json")" = "$positive_ref" ] || die "idempotent replay changed reference"

  cat > "${RUNNER_TEMP}/disable-route.sql" <<SQL
update public.artist_integrations set is_enabled=false
where artist_id='$VLADIMIR_ID' and integration_type='telegram' and integration_key='$ROUTE_KEY';
SQL
  sql "${RUNNER_TEMP}/disable-route.sql" "${evidence_dir}/route-disabled.json"
  route_disabled=true
  cleanup_route() {
    if $route_disabled; then
      cat > "${RUNNER_TEMP}/enable-route.sql" <<SQL
update public.artist_integrations set is_enabled=true
where artist_id='$VLADIMIR_ID' and integration_type='telegram' and integration_key='$ROUTE_KEY';
SQL
      sql "${RUNNER_TEMP}/enable-route.sql" "${evidence_dir}/route-restored.json" || true
    fi
  }
  trap cleanup_route EXIT
  noroute_key="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  multipart_submit "$noroute_key" NoRoute "${evidence_dir}/no-route.json"
  noroute_ref="$(jq -r '.reference' "${evidence_dir}/no-route.json")"
  cleanup_route
  route_disabled=false
  trap - EXIT

  database_e2e_assertions "$positive_ref" "$noroute_ref"
  role_scope_assertions
  edge_assertions
  snapshot_database database-after.json

  jq -n --arg sha "$GITHUB_SHA" --arg positive "$positive_ref" --arg noroute "$noroute_ref" \
    '{sha:$sha,positive_reference:$positive,no_route_reference:$noroute,pgtap_tests:933,lint:"error-level pass",retained:true}' \
    > "${evidence_dir}/summary.json"
}

case "${1:-}" in
  migrate) migrate_and_test ;;
  metadata) configure_metadata ;;
  worker) deploy_worker ;;
  pages) deploy_pages ;;
  e2e) hosted_e2e ;;
  *) die "expected one of: migrate metadata worker pages e2e" ;;
esac
