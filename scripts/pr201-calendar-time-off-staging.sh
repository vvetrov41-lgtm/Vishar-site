#!/usr/bin/env bash
set -euo pipefail

# Guarded retained-staging forward migration for PR #201.
# Applies exactly 0037..0041 in order, never resets retained staging, verifies
# pre-existing CRM/integration fingerprints, and runs transaction-wrapped hosted
# pgTAP plus lint. Provider calls and Worker deployment are handled separately
# by the guarded workflow after this script succeeds.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly EVIDENCE_DIR="${RUNNER_TEMP:?}/pr201-calendar-time-off-staging"
readonly EXPECTED_BEFORE="0036"
readonly EXPECTED_AFTER="0041"

mkdir -p "$EVIDENCE_DIR"

die() { echo "PR201 retained staging validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr201-sql.XXXXXX.json")"
  chmod 600 "$request_file"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" > "$output_file"
  rm -f "$request_file"
  jq -e 'type == "array"' "$output_file" >/dev/null \
    || die "hosted SQL response was not a row array"
}

verify_project_health() {
  local raw="$RUNNER_TEMP/pr201-project.json"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}" > "$raw"
  jq -e --arg ref "$PROJECT_REF" \
    '.id == $ref and .status == "ACTIVE_HEALTHY" and .region == "eu-west-2"' \
    "$raw" >/dev/null || die "retained staging is not the expected ACTIVE_HEALTHY project"
  jq '{id,status,region,database:{version:.database.version}}' "$raw" \
    > "$EVIDENCE_DIR/project-safe.json"
  rm -f "$raw"
}

write_snapshot() {
  local label="$1" query="$RUNNER_TEMP/pr201-${label}.sql" raw="$RUNNER_TEMP/pr201-${label}.json"
  cat > "$query" <<'SQL'
select jsonb_build_object(
  'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
  'core_counts', jsonb_build_object(
    'profiles', (select count(*)::integer from public.profiles),
    'memberships', (select count(*)::integer from public.artist_memberships),
    'clients', (select count(*)::integer from public.clients),
    'enquiries', (select count(*)::integer from public.enquiries),
    'projects', (select count(*)::integer from public.projects),
    'sessions', (select count(*)::integer from public.sessions),
    'activity_log', (select count(*)::integer from public.activity_log),
    'outbox', (select count(*)::integer from public.integration_outbox)
  ),
  'outbox_counts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'artist_id', artist_id, 'kind', kind, 'status', status, 'count', n
    ) order by artist_id, kind, status)
    from (
      select artist_id, kind, status, count(*)::integer n
      from public.integration_outbox
      group by artist_id, kind, status
    ) q
  ), '[]'::jsonb),
  'integrations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id,
      'artist_id', artist_id,
      'integration_type', integration_type,
      'provider', provider,
      'integration_key', integration_key,
      'is_enabled', is_enabled,
      'label_md5', md5(coalesce(external_account_label, '')),
      'configuration_md5', md5(configuration::text),
      'created_at', created_at,
      'updated_at', updated_at
    ) order by id)
    from public.artist_integrations
  ), '[]'::jsonb),
  'booking_sources', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id,
      'artist_id', artist_id,
      'source_key', source_key,
      'allowed_origin', allowed_origin,
      'form_version', form_version,
      'is_active', is_active,
      'created_at', created_at,
      'updated_at', updated_at
    ) order by id)
    from public.booking_sources
  ), '[]'::jsonb),
  'calendar_sessions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id,
      'artist_id', artist_id,
      'start_at', start_at,
      'end_at', end_at,
      'status', status,
      'calendar_provider', calendar_provider,
      'calendar_event_id', calendar_event_id,
      'calendar_version', calendar_version,
      'calendar_sync_status', calendar_sync_status,
      'calendar_last_synced_version', calendar_last_synced_version,
      'calendar_last_synced_at', calendar_last_synced_at,
      'calendar_last_error_code', calendar_last_error_code
    ) order by id)
    from public.sessions
    where calendar_version > 0 or calendar_event_id is not null
  ), '[]'::jsonb)
) as snapshot;
SQL
  sql "$query" "$raw"
  jq -e 'length == 1 and (.[0].snapshot | type == "object")' "$raw" >/dev/null \
    || die "invalid retained-staging snapshot"
  jq -S '.[0].snapshot' "$raw" > "$EVIDENCE_DIR/${label}.json"
  rm -f "$query" "$raw"
}

read_migration_versions() {
  local file="$1"
  awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9]{4}$/) print $2}' "$file"
}

verify_exact_history() {
  local file="$1" expected_count="$2" expected_last="$3"
  mapfile -t versions < <(read_migration_versions "$file")
  [ "${#versions[@]}" -eq "$expected_count" ] || die "unexpected migration count in $file"
  [ "${versions[-1]}" = "$expected_last" ] || die "unexpected latest migration in $file"
  for ((i = 1; i <= expected_count; i += 1)); do
    [ "${versions[i - 1]}" = "$(printf '%04d' "$i")" ] \
      || die "retained staging migration history has a gap at $(printf '%04d' "$i")"
  done
}

prepare_and_apply() {
  supabase link --project-ref "$PROJECT_REF" --password "$STAGING_SUPABASE_DB_PASSWORD"
  supabase migration list --linked > "$EVIDENCE_DIR/migrations-before.txt"
  verify_exact_history "$EVIDENCE_DIR/migrations-before.txt" 36 "$EXPECTED_BEFORE"

  write_snapshot before
  jq -e --arg expected "$EXPECTED_BEFORE" '.latest_migration == $expected' \
    "$EVIDENCE_DIR/before.json" >/dev/null || die "pre-state is not at migration 0036"

  supabase db push --linked --password "$STAGING_SUPABASE_DB_PASSWORD" --dry-run 2>&1 \
    | tee "$EVIDENCE_DIR/migration-dry-run.txt"
  for migration in \
    0037_team_access_management.sql \
    0038_manual_crm_enquiry_intake.sql \
    0039_artist_availability_time_off.sql \
    0040_calendar_availability_outbox_kinds.sql \
    0041_calendar_availability_projection.sql; do
    grep -Fq "$migration" "$EVIDENCE_DIR/migration-dry-run.txt" \
      || die "dry-run omitted $migration"
  done
  if grep -E '004[2-9]_|00[5-9][0-9]_' "$EVIDENCE_DIR/migration-dry-run.txt" >/dev/null; then
    die "dry-run included a migration after 0041"
  fi

  supabase db push --linked --password "$STAGING_SUPABASE_DB_PASSWORD" --yes
  supabase migration list --linked > "$EVIDENCE_DIR/migrations-after.txt"
  verify_exact_history "$EVIDENCE_DIR/migrations-after.txt" 41 "$EXPECTED_AFTER"
}

verify_post_state() {
  verify_project_health
  write_snapshot after
  jq -e --arg expected "$EXPECTED_AFTER" '.latest_migration == $expected' \
    "$EVIDENCE_DIR/after.json" >/dev/null || die "retained staging did not reach exactly 0041"

  # Forward schema migrations 0037..0041 must not mutate existing CRM records,
  # provider routing, booking-source configuration or appointment Calendar state.
  for key in core_counts outbox_counts integrations booking_sources calendar_sessions; do
    diff -u \
      <(jq -S ".${key}" "$EVIDENCE_DIR/before.json") \
      <(jq -S ".${key}" "$EVIDENCE_DIR/after.json") >/dev/null \
      || die "forward migration changed pre-existing ${key}"
  done

  local check="$RUNNER_TEMP/pr201-post.sql" raw="$RUNNER_TEMP/pr201-post.json"
  cat > "$check" <<'SQL'
select jsonb_build_object(
  'availability_rows', (select count(*)::integer from public.artist_availability_blocks),
  'availability_jobs', (select count(*)::integer from public.integration_outbox where kind in (
    'calendar_availability_create','calendar_availability_update','calendar_availability_cancel'
  )),
  'claimable_calendar_jobs', (select count(*)::integer from public.integration_outbox where kind in (
    'calendar_create','calendar_update','calendar_cancel',
    'calendar_availability_create','calendar_availability_update','calendar_availability_cancel'
  ) and (
    (status in ('pending','failed') and next_attempt_at <= now())
    or (status = 'leased' and lease_expires_at <= now())
  )),
  'staff_invites', (select count(*)::integer from crm_private.staff_invites),
  'manual_receipts', (select count(*)::integer from crm_private.manual_enquiry_receipts),
  'vladimir_calendar_routes', (select count(*)::integer from public.artist_integrations where artist_id='a1111111-1111-4111-8111-111111111111' and integration_type='calendar' and provider='google' and integration_key='google_calendar_vladimir' and is_enabled),
  'kristina_calendar_routes', (select count(*)::integer from public.artist_integrations where artist_id='a2222222-2222-4222-8222-222222222222' and integration_type='calendar' and provider='google' and integration_key='google_calendar_kristina' and is_enabled),
  'availability_table_force_rls', (select relforcerowsecurity from pg_class where oid='public.artist_availability_blocks'::regclass),
  'claim_anon', has_function_privilege('anon','public.claim_calendar_availability_outbox(text,integer,integer)','EXECUTE'),
  'claim_authenticated', has_function_privilege('authenticated','public.claim_calendar_availability_outbox(text,integer,integer)','EXECUTE'),
  'claim_service', has_function_privilege('service_role','public.claim_calendar_availability_outbox(text,integer,integer)','EXECUTE'),
  'ack_anon', has_function_privilege('anon','public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)','EXECUTE'),
  'ack_authenticated', has_function_privilege('authenticated','public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)','EXECUTE'),
  'ack_service', has_function_privilege('service_role','public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)','EXECUTE')
) as checks;
SQL
  sql "$check" "$raw"
  jq -S '.[0].checks' "$raw" > "$EVIDENCE_DIR/post-checks.json"
  rm -f "$check" "$raw"
  jq -e '
    .availability_rows == 0
    and .availability_jobs == 0
    and .claimable_calendar_jobs == 0
    and .staff_invites == 0
    and .manual_receipts == 0
    and .vladimir_calendar_routes == 1
    and .kristina_calendar_routes == 0
    and .availability_table_force_rls == true
    and .claim_anon == false
    and .claim_authenticated == false
    and .claim_service == true
    and .ack_anon == false
    and .ack_authenticated == false
    and .ack_service == true
  ' "$EVIDENCE_DIR/post-checks.json" >/dev/null || die "post-migration security/state boundary is invalid"

  for test_file in \
    supabase/tests/192_team_access_management.sql \
    supabase/tests/193_manual_crm_intake.sql \
    supabase/tests/194_artist_availability_time_off.sql \
    supabase/tests/195_calendar_availability_projection.sql; do
    supabase test db "$test_file" --linked 2>&1 | tee -a "$EVIDENCE_DIR/hosted-pgtap.txt"
  done
  supabase db lint --linked --schema public,crm_private --level error --fail-on error 2>&1 \
    | tee "$EVIDENCE_DIR/hosted-lint.txt"
  npm run scan:secrets | tee "$EVIDENCE_DIR/final-secret-scan.txt"

  jq -n \
    --arg head_sha "${APPROVED_SHA:?}" '
    {
      project_ref:"gwaliusblwrzisrwnsvs",
      migration_before:"0036",
      migration_after:"0041",
      head_sha:$head_sha,
      existing_crm_rows_unchanged:true,
      existing_outbox_unchanged:true,
      integrations_unchanged:true,
      booking_sources_unchanged:true,
      existing_calendar_sessions_unchanged:true,
      availability_rows_before_e2e:0,
      availability_jobs_before_e2e:0,
      claimable_calendar_jobs_before_e2e:0,
      vladimir_calendar_route_preserved:true,
      kristina_calendar_route_not_yet_activated:true,
      force_rls:true,
      backend_claim_ack_service_only:true,
      hosted_pgtap:"passed",
      hosted_lint:"passed",
      secret_scan:"passed",
      production_targeted:false
    }
  ' > "$EVIDENCE_DIR/summary.json"
}

for name in SUPABASE_ACCESS_TOKEN STAGING_SUPABASE_DB_PASSWORD SUPABASE_DB_PASSWORD APPROVED_SHA; do
  require_env "$name"
done
[ "${PRODUCTION_TARGETED:-false}" = 'false' ] || die "production target must remain false"
verify_project_health
prepare_and_apply
verify_post_state

echo "PR201 retained staging forward migration 0037..0041 validation succeeded"
