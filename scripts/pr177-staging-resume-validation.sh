#!/usr/bin/env bash
set -euo pipefail

# Resume-only hosted staging gate for draft PR #177.
# Preconditions:
# - retained vishar-crm-staging already has migrations 0001 through 0025;
# - production is never targeted;
# - canonical pgTAP runs against a transactionally cleaned view of retained data;
# - every test file rolls back, and the retained snapshot must match exactly afterward.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly EXPECTED_TESTS="933"
readonly TEST_SOURCE="supabase/tests"
readonly ISOLATED_TEST_DIR="supabase/tests-hosted-pr177"

evidence_dir="${RUNNER_TEMP:?}/pr177-staging-evidence"
mkdir -p "$evidence_dir"

die() { echo "staging resume validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted secret $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr177-resume-sql.XXXXXX.json")"
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

snapshot_database() {
  local target="$1"
  cat > "${RUNNER_TEMP}/pr177-resume-snapshot.sql" <<'SQL'
select jsonb_build_object(
  'migration_versions', (
    select coalesce(jsonb_agg(version order by version), '[]'::jsonb)
    from supabase_migrations.schema_migrations
  ),
  'profiles', (select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from public.profiles),
  'clients', (select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from public.clients),
  'enquiries', (select coalesce(jsonb_agg(jsonb_build_array(id, reference_number, status) order by id), '[]'::jsonb) from public.enquiries),
  'projects', (select coalesce(jsonb_agg(jsonb_build_array(id, status, currency) order by id), '[]'::jsonb) from public.projects),
  'enquiry_files', (select coalesce(jsonb_agg(jsonb_build_array(id, storage_path, upload_state) order by id), '[]'::jsonb) from public.enquiry_files),
  'storage_objects', (select coalesce(jsonb_agg(jsonb_build_array(id, name) order by id), '[]'::jsonb) from storage.objects where bucket_id='crm-files'),
  'outbox', (select coalesce(jsonb_agg(jsonb_build_array(id, status, attempt_count, last_error_code) order by id), '[]'::jsonb) from public.integration_outbox),
  'activity', (select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from public.activity_log),
  'artists', (select coalesce(jsonb_agg(jsonb_build_array(id, slug, is_active) order by id), '[]'::jsonb) from public.artists),
  'memberships', (select coalesce(jsonb_agg(jsonb_build_array(profile_id, artist_id, is_active) order by profile_id, artist_id), '[]'::jsonb) from public.artist_memberships),
  'booking_sources', (select coalesce(jsonb_agg(jsonb_build_array(id, source_key, is_active) order by id), '[]'::jsonb) from public.booking_sources),
  'artist_integrations', (select coalesce(jsonb_agg(jsonb_build_array(id, artist_id, integration_type, integration_key, is_enabled) order by id), '[]'::jsonb) from public.artist_integrations)
) as snapshot;
SQL
  sql "${RUNNER_TEMP}/pr177-resume-snapshot.sql" "$target"
  jq -S . "$target" > "${target}.sorted"
}

verify_migrations() {
  npx supabase@2.111.0 link --project-ref "$PROJECT_REF"
  npx supabase@2.111.0 migration list --linked > "${evidence_dir}/resume-migrations.txt"
  mapfile -t remote_versions < <(
    awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9][0-9][0-9][0-9]$/) print $2}' \
      "${evidence_dir}/resume-migrations.txt"
  )
  [ "${#remote_versions[@]}" -eq 25 ] || die "retained staging must contain exactly migrations 0001 through 0025"
  for n in $(seq -w 1 25); do
    printf '%s\n' "${remote_versions[@]}" | grep -Fxq "00$n" || die "remote migration 00$n is absent"
  done
}

prepare_isolated_tests() {
  rm -rf "$ISOLATED_TEST_DIR"
  mkdir -p "$ISOLATED_TEST_DIR"

  local source target injected
  for source in "$TEST_SOURCE"/*.sql "$TEST_SOURCE"/*.pg; do
    [ -f "$source" ] || continue
    target="$ISOLATED_TEST_DIR/$(basename "$source")"
    injected="$(mktemp "${RUNNER_TEMP}/pr177-injected.XXXXXX")"
    cat > "$injected" <<'SQL'
set local role postgres;
truncate table
  public.activity_log,
  public.artist_integrations,
  public.artist_memberships,
  public.artist_payment_policies,
  public.clients,
  public.email_messages,
  public.enquiries,
  public.enquiry_files,
  public.follow_ups,
  public.integration_outbox,
  public.internal_notes,
  public.payment_requests,
  public.payment_transactions,
  public.payment_webhook_events,
  public.profiles,
  public.project_files,
  public.projects,
  public.retention_holds,
  public.sessions
restart identity cascade;
delete from storage.objects where bucket_id = 'crm-files';
SQL

    awk -v injected="$injected" '
      !done && /^[[:space:]]*begin;[[:space:]]*$/ {
        print;
        while ((getline line < injected) > 0) print line;
        close(injected);
        done=1;
        next;
      }
      { print }
      END { if (!done) exit 42 }
    ' "$source" > "$target" || die "could not inject isolated cleanup into $(basename "$source")"
    rm -f "$injected"
  done

  [ "$(find "$ISOLATED_TEST_DIR" -maxdepth 1 -type f \( -name '*.sql' -o -name '*.pg' \) | wc -l)" -eq 15 ] \
    || die "expected exactly 15 canonical pgTAP files"
}

run_isolated_pgtap() {
  snapshot_database "${evidence_dir}/retained-before-hosted-pgtap.json"
  prepare_isolated_tests

  set +e
  npx supabase@2.111.0 test db "$ISOLATED_TEST_DIR" --linked 2>&1 \
    | tee "${evidence_dir}/hosted-pgtap-isolated.txt"
  test_status=${PIPESTATUS[0]}
  set -e

  snapshot_database "${evidence_dir}/retained-after-hosted-pgtap.json"
  cmp -s \
    "${evidence_dir}/retained-before-hosted-pgtap.json.sorted" \
    "${evidence_dir}/retained-after-hosted-pgtap.json.sorted" \
    || die "retained staging state changed during isolated pgTAP"

  rm -rf "$ISOLATED_TEST_DIR"
  [ "$test_status" -eq 0 ] || die "isolated hosted pgTAP failed"
  grep -Eq "Tests=${EXPECTED_TESTS}([^0-9]|$)|1\\.\\.${EXPECTED_TESTS}([^0-9]|$)" \
    "${evidence_dir}/hosted-pgtap-isolated.txt" || die "hosted pgTAP count was not exactly ${EXPECTED_TESTS}"
  grep -Eq 'Result:[[:space:]]*PASS|All tests successful' \
    "${evidence_dir}/hosted-pgtap-isolated.txt" || die "hosted pgTAP did not pass"
}

run_lint() {
  npx supabase@2.111.0 db lint --linked --schema public,crm_private --level error --fail-on error \
    2>&1 | tee "${evidence_dir}/hosted-lint-resume.txt"
}

require_env SUPABASE_ACCESS_TOKEN
require_env SUPABASE_DB_PASSWORD
verify_migrations
run_isolated_pgtap
run_lint
