#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly CRM_ORIGIN="https://vishar-crm-staging.pages.dev"
readonly VLADIMIR_ID="a1111111-1111-4111-8111-111111111111"
evidence_dir="${RUNNER_TEMP:?}/pr179-staging-evidence"
mkdir -p "$evidence_dir"

die() { echo "PR179 staging validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted secret $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr179-sql.XXXXXX.json")"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" > "$output_file"
  rm -f "$request_file"
  jq -e 'if type == "array" then true else ((.error // null) == null and (.result // null) != null) end' "$output_file" >/dev/null \
    || die "hosted SQL request failed"
}

rows() { jq -c 'if type == "array" then . else .result end' "$1"; }
migration_versions() { awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9]{4}$/) print $2}' "$1"; }
verify_migrations() {
  local file="$1" expected="$2"
  mapfile -t versions < <(migration_versions "$file")
  [ "${#versions[@]}" -eq "$expected" ] || die "expected $expected migrations, found ${#versions[@]}"
  for n in $(seq -w 1 "$expected"); do printf '%s\n' "${versions[@]}" | grep -Fxq "00$n" || die "migration 00$n missing"; done
}

snapshot() {
  cat > "${RUNNER_TEMP}/pr179-snapshot.sql" <<'SQL'
select jsonb_build_object(
  'sessions', (select count(*) from public.sessions),
  'outbox', (select count(*) from public.integration_outbox),
  'activity', (select count(*) from public.activity_log)
) as snapshot;
SQL
  sql "${RUNNER_TEMP}/pr179-snapshot.sql" "$1"
}

migrate_and_check() {
  require_env SUPABASE_ACCESS_TOKEN
  require_env SUPABASE_DB_PASSWORD
  npx supabase@2.111.0 link --project-ref "$PROJECT_REF"
  npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-before.txt"
  mapfile -t versions < <(migration_versions "${evidence_dir}/migrations-before.txt")
  case "${#versions[@]}" in 27) verify_migrations "${evidence_dir}/migrations-before.txt" 27 ;; 28) verify_migrations "${evidence_dir}/migrations-before.txt" 28 ;; *) die "retained staging must contain 0001-0027 or 0001-0028" ;; esac
  snapshot "${evidence_dir}/database-before.json"
  if [ "${#versions[@]}" -eq 27 ]; then
    npx supabase@2.111.0 db push --linked --dry-run 2>&1 | tee "${evidence_dir}/migration-0028-dry-run.txt"
    grep -Fq '0028_calendar_projection_foundation.sql' "${evidence_dir}/migration-0028-dry-run.txt" || die "dry-run omitted 0028"
    if grep -Eq '00(2[9]|[3-9][0-9])_' "${evidence_dir}/migration-0028-dry-run.txt"; then die "dry-run included migration after 0028"; fi
    npx supabase@2.111.0 db push --linked --yes
  fi
  npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-after.txt"
  verify_migrations "${evidence_dir}/migrations-after.txt" 28

  cat > "${RUNNER_TEMP}/pr179-schema.sql" <<'SQL'
select jsonb_build_object(
  'migration_0028', exists(select 1 from supabase_migrations.schema_migrations where version='0028'),
  'sync_status', exists(select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='calendar_sync_status'),
  'last_synced_version', exists(select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='calendar_last_synced_version'),
  'reschedule_rpc', to_regprocedure('public.reschedule_appointment(uuid,timestamptz,timestamptz)') is not null,
  'result_rpc', to_regprocedure('public.record_calendar_sync_result(uuid,integer,boolean,public.calendar_provider,text,text)') is not null
) as check;
SQL
  sql "${RUNNER_TEMP}/pr179-schema.sql" "${evidence_dir}/schema-check.json"
  rows "${evidence_dir}/schema-check.json" | jq -e '.[0].check | .migration_0028 and .sync_status and .last_synced_version and .reschedule_rpc and .result_rpc' >/dev/null \
    || die "calendar projection schema check failed"
  npx supabase@2.111.0 db lint --linked --schema public,crm_private --level error --fail-on error 2>&1 | tee "${evidence_dir}/hosted-lint.txt"
}

run_e2e() {
  snapshot "${evidence_dir}/database-before-e2e.json"
  cat > "${RUNNER_TEMP}/pr179-e2e.sql" <<SQL
begin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select profile_id from crm_private.profile_access where role='owner' and is_active order by profile_id limit 1),
  'role', 'authenticated')::text, true);
set local role authenticated;

do \$e2e\$
declare
  v_project uuid; v_client uuid; v_enquiry uuid; v_id uuid; v_result jsonb;
  v_start timestamptz := date_trunc('day', now()) + interval '650 days 10 hours';
begin
  select p.id,p.client_id,p.enquiry_id into v_project,v_client,v_enquiry
  from public.projects p join public.clients c on c.id=p.client_id
  where p.artist_id='${VLADIMIR_ID}'::uuid and p.archived_at is null and c.email ~* '@example\\.(invalid|com)$'
  order by p.created_at,p.id limit 1;
  if v_project is null then raise exception 'synthetic project required'; end if;
  v_result := public.schedule_appointment('${VLADIMIR_ID}'::uuid,v_client,'tattoo_session',v_start,v_start+interval '7 hours','confirmed',v_enquiry,v_project,'PR179 synthetic calendar projection');
  v_id := (v_result->>'appointment_id')::uuid;
  if (select calendar_sync_status from public.sessions where id=v_id) <> 'not_connected' then raise exception 'initial calendar state mismatch'; end if;
  v_result := public.reschedule_appointment(v_id,v_start+interval '1 day',v_start+interval '1 day 7 hours');
  if not (v_result->>'changed')::boolean then raise exception 'reschedule did not change'; end if;
  if (select calendar_sync_status from public.sessions where id=v_id) <> 'queued' then raise exception 'reschedule was not queued'; end if;
  if (select count(*) from public.integration_outbox where session_id=v_id and kind='calendar_create') < 2 then raise exception 'versioned calendar create missing'; end if;
  reset role;
  perform public.record_calendar_sync_result(v_id,1,true,'google','pr179-synthetic-event',null);
  if (select calendar_sync_status from public.sessions where id=v_id) <> 'synced' then raise exception 'successful sync not visible'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',(select profile_id from crm_private.profile_access where role='owner' and is_active order by profile_id limit 1),'role','authenticated')::text,true);
  set local role authenticated;
  perform public.reschedule_appointment(v_id,v_start+interval '2 days',v_start+interval '2 days 7 hours');
  reset role;
  if not (public.record_calendar_sync_result(v_id,1,false,'google',null,'stale_failure')->>'stale')::boolean then raise exception 'stale response was applied'; end if;
end
\$e2e\$;
rollback;
select jsonb_build_object('ok',true,'reschedule',true,'queued',true,'synced',true,'stale_protected',true,'rolled_back',true) as summary;
SQL
  sql "${RUNNER_TEMP}/pr179-e2e.sql" "${evidence_dir}/calendar-e2e.json"
  rows "${evidence_dir}/calendar-e2e.json" | jq -e '.[-1].summary | .ok and .reschedule and .queued and .synced and .stale_protected and .rolled_back' >/dev/null \
    || die "calendar E2E summary failed"
  snapshot "${evidence_dir}/database-after-e2e.json"
  before="$(rows "${evidence_dir}/database-before-e2e.json" | jq -c '.[0].snapshot')"
  after="$(rows "${evidence_dir}/database-after-e2e.json" | jq -c '.[0].snapshot')"
  [ "$before" = "$after" ] || die "calendar E2E left persistent rows"
}

deploy_crm() {
  require_env CLOUDFLARE_API_TOKEN
  require_env CLOUDFLARE_ACCOUNT_ID
  require_env VITE_SUPABASE_URL
  require_env VITE_SUPABASE_PUBLISHABLE_KEY
  grep -Fq 'rescheduleAppointment' admin/src/pages/AppointmentsPage.tsx
  grep -Fq 'calendarSyncLabel' admin/src/pages/AppointmentsPage.tsx
  (cd admin && npm ci && npm test && npm run typecheck && npm run build)
  test -f admin/dist/index.html
  ! grep -R -E -q 'sb_secret_[A-Za-z0-9_-]{20,}' admin/dist
  npx wrangler pages deploy admin/dist --project-name vishar-crm-staging --branch main --commit-hash "$GITHUB_SHA" --commit-message "PR179 calendar foundation staging $GITHUB_SHA" --commit-dirty=true 2>&1 | tee "${evidence_dir}/crm-deploy.txt"
  curl --silent --show-error --dump-header "${evidence_dir}/crm-access-headers.txt" --output /dev/null "$CRM_ORIGIN/"
  status="$(awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' "${evidence_dir}/crm-access-headers.txt")"
  case "$status" in 302|303) ;; *) die "CRM staging Access redirect missing (status $status)" ;; esac
  grep -Eiq '^location: .*cloudflareaccess\.com/' "${evidence_dir}/crm-access-headers.txt" || die "CRM redirect did not target Access"
}

case "${1:-all}" in migrate) migrate_and_check ;; e2e) run_e2e ;; deploy) deploy_crm ;; all) migrate_and_check; run_e2e; deploy_crm ;; *) die "unknown mode" ;; esac
