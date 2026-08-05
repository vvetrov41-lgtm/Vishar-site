#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly STAGING_SUPABASE_ORIGIN="https://${PROJECT_REF}.supabase.co"
readonly CRM_ORIGIN="https://vishar-crm-staging.pages.dev"
readonly EXPECTED_MIGRATIONS=30
readonly EVIDENCE_DIR="${RUNNER_TEMP:?}/pr181-staging-evidence"
mkdir -p "$EVIDENCE_DIR"

die() {
  echo "PR181 staging validation failed: $*" >&2
  exit 1
}

require_env() {
  [ -n "${!1:-}" ] || die "required encrypted secret $1 is unavailable"
}

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr181-sql.XXXXXX.json")"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" > "$output_file"
  rm -f "$request_file"
  jq -e '
    if type == "array" then true
    else ((.error // null) == null and (.result // null) != null)
    end
  ' "$output_file" >/dev/null || die "hosted SQL request failed"
}

rows() {
  jq -c 'if type == "array" then . else .result end' "$1"
}

migration_versions() {
  awk -F'|' '{
    gsub(/[[:space:]`]/, "", $2)
    if ($2 ~ /^[0-9]{4}$/) print $2
  }' "$1"
}

verify_migrations() {
  local file="$1" expected="$2"
  local -a versions
  mapfile -t versions < <(migration_versions "$file")
  [ "${#versions[@]}" -eq "$expected" ] \
    || die "expected $expected migrations, found ${#versions[@]}"
  local number version
  for number in $(seq 1 "$expected"); do
    printf -v version '%04d' "$number"
    printf '%s\n' "${versions[@]}" | grep -Fxq "$version" \
      || die "migration $version missing"
  done
}

snapshot() {
  local output_file="$1"
  cat > "${RUNNER_TEMP}/pr181-snapshot.sql" <<'SQL'
select jsonb_build_object(
  'clients', (select count(*) from public.clients),
  'enquiries', (select count(*) from public.enquiries),
  'projects', (select count(*) from public.projects),
  'sessions', (select count(*) from public.sessions),
  'outbox', (select count(*) from public.integration_outbox),
  'activity', (select count(*) from public.activity_log)
) as snapshot;
SQL
  sql "${RUNNER_TEMP}/pr181-snapshot.sql" "$output_file"
}

validate_dry_run() {
  local current_count="$1" file="$2"
  case "$current_count" in
    28)
      grep -Fq '0029_calendar_outbox_drain.sql' "$file" \
        || die "dry-run omitted migration 0029"
      grep -Fq '0030_calendar_connection_status.sql' "$file" \
        || die "dry-run omitted migration 0030"
      ;;
    29)
      ! grep -Fq '0029_calendar_outbox_drain.sql' "$file" \
        || die "dry-run attempted to reapply migration 0029"
      grep -Fq '0030_calendar_connection_status.sql' "$file" \
        || die "dry-run omitted migration 0030"
      ;;
    *)
      die "dry-run validation received unsupported migration count $current_count"
      ;;
  esac
  if grep -Eq '00(3[1-9]|[4-9][0-9])_' "$file"; then
    die "dry-run included a migration after 0030"
  fi
}

migrate_and_check() {
  require_env SUPABASE_ACCESS_TOKEN
  require_env SUPABASE_DB_PASSWORD
  require_env STAGING_SUPABASE_URL
  [ "$STAGING_SUPABASE_URL" = "$STAGING_SUPABASE_ORIGIN" ] \
    || die "unexpected staging Supabase URL"

  npx --yes supabase@2.111.0 link --project-ref "$PROJECT_REF"
  npx --yes supabase@2.111.0 migration list --linked \
    > "${EVIDENCE_DIR}/migrations-before.txt"

  local -a versions
  mapfile -t versions < <(migration_versions "${EVIDENCE_DIR}/migrations-before.txt")
  case "${#versions[@]}" in
    28|29|30) verify_migrations "${EVIDENCE_DIR}/migrations-before.txt" "${#versions[@]}" ;;
    *) die "retained staging must contain consecutive migrations 0001-0028, 0001-0029 or 0001-0030" ;;
  esac

  snapshot "${EVIDENCE_DIR}/database-before.json"

  if [ "${#versions[@]}" -lt "$EXPECTED_MIGRATIONS" ]; then
    npx --yes supabase@2.111.0 db push --linked --dry-run 2>&1 \
      | tee "${EVIDENCE_DIR}/migration-dry-run.txt"
    validate_dry_run "${#versions[@]}" "${EVIDENCE_DIR}/migration-dry-run.txt"
    npx --yes supabase@2.111.0 db push --linked --yes
  fi

  npx --yes supabase@2.111.0 migration list --linked \
    > "${EVIDENCE_DIR}/migrations-after.txt"
  verify_migrations "${EVIDENCE_DIR}/migrations-after.txt" "$EXPECTED_MIGRATIONS"

  snapshot "${EVIDENCE_DIR}/database-after.json"
  local before after
  before="$(rows "${EVIDENCE_DIR}/database-before.json" | jq -c '.[0].snapshot')"
  after="$(rows "${EVIDENCE_DIR}/database-after.json" | jq -c '.[0].snapshot')"
  [ "$before" = "$after" ] || die "forward migrations changed retained CRM row counts"

  cat > "${RUNNER_TEMP}/pr181-schema.sql" <<'SQL'
select jsonb_build_object(
  'migration_0029', exists(
    select 1 from supabase_migrations.schema_migrations where version = '0029'
  ),
  'migration_0030', exists(
    select 1 from supabase_migrations.schema_migrations where version = '0030'
  ),
  'claim_rpc', to_regprocedure(
    'public.claim_calendar_outbox(text,integer,integer)'
  ) is not null,
  'result_rpc', to_regprocedure(
    'public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)'
  ) is not null,
  'status_rpc', to_regprocedure(
    'public.list_calendar_connection_status()'
  ) is not null,
  'claim_service', has_function_privilege(
    'service_role',
    'public.claim_calendar_outbox(text,integer,integer)',
    'EXECUTE'
  ),
  'claim_authenticated_denied', not has_function_privilege(
    'authenticated',
    'public.claim_calendar_outbox(text,integer,integer)',
    'EXECUTE'
  ),
  'result_service', has_function_privilege(
    'service_role',
    'public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)',
    'EXECUTE'
  ),
  'result_authenticated_denied', not has_function_privilege(
    'authenticated',
    'public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)',
    'EXECUTE'
  ),
  'status_authenticated', has_function_privilege(
    'authenticated',
    'public.list_calendar_connection_status()',
    'EXECUTE'
  ),
  'status_anon_denied', not has_function_privilege(
    'anon',
    'public.list_calendar_connection_status()',
    'EXECUTE'
  ),
  'status_service_denied', not has_function_privilege(
    'service_role',
    'public.list_calendar_connection_status()',
    'EXECUTE'
  )
) as check;
SQL
  sql "${RUNNER_TEMP}/pr181-schema.sql" "${EVIDENCE_DIR}/schema-check.json"
  rows "${EVIDENCE_DIR}/schema-check.json" | jq -e '
    .[0].check
    | .migration_0029
      and .migration_0030
      and .claim_rpc
      and .result_rpc
      and .status_rpc
      and .claim_service
      and .claim_authenticated_denied
      and .result_service
      and .result_authenticated_denied
      and .status_authenticated
      and .status_anon_denied
      and .status_service_denied
  ' >/dev/null || die "Calendar Connections hosted schema or ACL check failed"

  npx --yes supabase@2.111.0 db lint --linked \
    --schema public,crm_private \
    --level error \
    --fail-on error 2>&1 | tee "${EVIDENCE_DIR}/hosted-lint.txt"
}

deploy_crm() {
  require_env CLOUDFLARE_API_TOKEN
  require_env CLOUDFLARE_ACCOUNT_ID
  require_env VITE_SUPABASE_URL
  require_env VITE_SUPABASE_PUBLISHABLE_KEY
  require_env SOURCE_SHA

  [ "$VITE_SUPABASE_URL" = "$STAGING_SUPABASE_ORIGIN" ] \
    || die "CRM build does not target retained staging Supabase"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "SOURCE_SHA is invalid"

  grep -Fq "path: '/integrations'" admin/src/lib/permissions.ts
  grep -Fq "path: '/integrations/calendar'" admin/src/App.tsx
  grep -Fq "list_calendar_connection_status" admin/src/lib/calendar-connections-api.ts
  grep -Fq "calendar-staging.vishartattoo.com" admin/src/pages/CalendarConnectionsPage.tsx
  grep -Fq "#/integrations/calendar" wrangler.calendar.staging.toml
  grep -Fq "#/appointments" wrangler.calendar.staging.toml

  (
    cd admin
    npm ci
    npm audit --audit-level=moderate
    npm test
    npm run typecheck
    npm run build
  )

  test -f admin/dist/index.html || die "CRM build artifact is missing"
  ! grep -R -E -q \
    'sb_secret_[A-Za-z0-9_-]{20,}|service_role|refresh_token|Cf-Access-Jwt-Assertion' \
    admin/dist || die "CRM artifact contains a forbidden secret marker"

  npx --yes wrangler@4 pages deploy admin/dist \
    --project-name vishar-crm-staging \
    --branch main \
    --commit-hash "$SOURCE_SHA" \
    --commit-message "PR181 Calendar Connections staging ${SOURCE_SHA}" \
    --commit-dirty=true 2>&1 | tee "${EVIDENCE_DIR}/crm-deploy.txt"

  curl --silent --show-error \
    --dump-header "${EVIDENCE_DIR}/crm-access-headers.txt" \
    --output /dev/null \
    --max-time 15 \
    "$CRM_ORIGIN/"
  local status
  status="$(awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' \
    "${EVIDENCE_DIR}/crm-access-headers.txt")"
  case "$status" in
    302|303|307) ;;
    *) die "CRM staging Access redirect missing (status $status)" ;;
  esac
  grep -Eiq '^location: .*cloudflareaccess\.com/' \
    "${EVIDENCE_DIR}/crm-access-headers.txt" \
    || die "CRM staging redirect did not target Cloudflare Access"

  jq -n \
    --arg source_sha "$SOURCE_SHA" \
    --arg project_ref "$PROJECT_REF" \
    --arg crm_origin "$CRM_ORIGIN" \
    '{
      source_sha: $source_sha,
      project_ref: $project_ref,
      crm_origin: $crm_origin,
      migration_target: "0030",
      calendar_worker_deployed: false,
      oauth_performed: false,
      production_targeted: false
    }' > "${EVIDENCE_DIR}/summary.json"
}

case "${1:-all}" in
  migrate) migrate_and_check ;;
  deploy) deploy_crm ;;
  all) migrate_and_check; deploy_crm ;;
  *) die "unknown mode" ;;
esac
