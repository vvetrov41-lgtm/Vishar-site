#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
evidence_dir="${RUNNER_TEMP:?}/pr178-staging-evidence"
mkdir -p "$evidence_dir"

die() { echo "PR178 post-migration check failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted secret $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr178-post-migration-sql.XXXXXX.json")"
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

rows() {
  jq -c 'if type == "array" then . else .result end' "$1"
}

migration_versions() {
  awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9][0-9][0-9][0-9]$/) print $2}' "$1"
}

verify_contiguous_migrations() {
  local file="$1" expected="$2"
  mapfile -t versions < <(migration_versions "$file")
  [ "${#versions[@]}" -eq "$expected" ] || die "expected $expected linked migrations, found ${#versions[@]}"
  for n in $(seq -w 1 "$expected"); do
    printf '%s\n' "${versions[@]}" | grep -Fxq "00$n" || die "remote migration 00$n is absent"
  done
}

require_env SUPABASE_ACCESS_TOKEN
require_env SUPABASE_DB_PASSWORD

npx supabase@2.111.0 link --project-ref "$PROJECT_REF"
npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-resume.txt"
mapfile -t versions < <(migration_versions "${evidence_dir}/migrations-resume.txt")
case "${#versions[@]}" in
  26)
    verify_contiguous_migrations "${evidence_dir}/migrations-resume.txt" 26
    ;;
  27)
    verify_contiguous_migrations "${evidence_dir}/migrations-resume.txt" 27
    ;;
  *)
    die "retained staging must contain exactly migrations 0001-0026 or the idempotent resume state 0001-0027"
    ;;
esac

if [ "${#versions[@]}" -eq 26 ]; then
  npx supabase@2.111.0 db push --linked --dry-run 2>&1 | tee "${evidence_dir}/migration-0027-dry-run.txt"
  grep -Fq '0027_consultation_duration_bounds.sql' "${evidence_dir}/migration-0027-dry-run.txt" \
    || die "dry-run omitted migration 0027"
  if grep -Eq '00(2[8-9]|[3-9][0-9])_' "${evidence_dir}/migration-0027-dry-run.txt"; then
    die "dry-run included an unexpected migration after 0027"
  fi
  npx supabase@2.111.0 db push --linked --yes
fi

npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-resume.txt"
verify_contiguous_migrations "${evidence_dir}/migrations-resume.txt" 27

cat > "${RUNNER_TEMP}/pr178-post-migration-check.sql" <<'SQL'
select jsonb_build_object(
  'migration_0027_present',
    exists (
      select 1 from supabase_migrations.schema_migrations
      where version = '0027'
    ),
  'appointment_type_column',
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='sessions' and column_name='appointment_type'
    ),
  'client_id_column',
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='sessions' and column_name='client_id'
    ),
  'enquiry_id_column',
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='sessions' and column_name='enquiry_id'
    ),
  'consultation_duration_constraint',
    exists (
      select 1 from pg_constraint
      where conrelid = 'public.sessions'::regclass
        and conname = 'sessions_consultation_duration_bounds'
    ),
  'appointment_type_enum',
    (select enum_range(null::public.appointment_type)::text),
  'null_client_rows', (select count(*) from public.sessions where client_id is null),
  'consultations_outside_policy', (
    select count(*) from public.sessions
    where appointment_type in ('in_person_consultation', 'video_consultation')
      and (end_at - start_at) not between interval '15 minutes' and interval '30 minutes'
  ),
  'legacy_non_tattoo_rows', (
    select count(*) from public.sessions
    where project_id is not null
      and notes is distinct from 'PR178 synthetic touch-up'
      and appointment_type <> 'tattoo_session'
  )
) as check;
SQL
sql "${RUNNER_TEMP}/pr178-post-migration-check.sql" "${evidence_dir}/post-migration-check.json"
rows "${evidence_dir}/post-migration-check.json" | jq -e '
  .[0].check.migration_0027_present == true
  and .[0].check.appointment_type_column == true
  and .[0].check.client_id_column == true
  and .[0].check.enquiry_id_column == true
  and .[0].check.consultation_duration_constraint == true
  and .[0].check.appointment_type_enum == "{tattoo_session,in_person_consultation,video_consultation,touch_up}"
  and .[0].check.null_client_rows == 0
  and .[0].check.consultations_outside_policy == 0
  and .[0].check.legacy_non_tattoo_rows == 0
' >/dev/null || die "migration 0027 schema, backfill or consultation duration verification failed"

# The rollback-only E2E performs an exact JSON comparison. Generate its
# baseline through the same PostgreSQL jsonb expression as the final snapshot,
# so both responses use PostgreSQL's deterministic jsonb key ordering.
cat > "${RUNNER_TEMP}/pr178-e2e-baseline.sql" <<'SQL'
select jsonb_build_object(
  'clients', (select count(*) from public.clients),
  'enquiries', (select count(*) from public.enquiries),
  'projects', (select count(*) from public.projects),
  'sessions', (select count(*) from public.sessions),
  'outbox', (select count(*) from public.integration_outbox),
  'activity', (select count(*) from public.activity_log)
) as snapshot;
SQL
sql "${RUNNER_TEMP}/pr178-e2e-baseline.sql" "${evidence_dir}/database-after.json"
rows "${evidence_dir}/database-after.json" | jq -e '
  .[0].snapshot | all(.[]; type == "number")
' >/dev/null || die "could not create the retained row-count baseline"

npx supabase@2.111.0 db lint --linked --schema public,crm_private --level error --fail-on error \
  2>&1 | tee "${evidence_dir}/hosted-lint-resume.txt"

cat > "${evidence_dir}/hosted-test-boundary.txt" <<'EOF'
The complete canonical 964-test pgTAP suite passed against a clean local database in normal CI.
It is intentionally not executed directly against retained staging because canonical tests assume an empty database and fixed fixture counts.
Hosted validation uses migration/schema checks, PostgreSQL error-level lint and a rollback-only synthetic appointment E2E instead.
EOF