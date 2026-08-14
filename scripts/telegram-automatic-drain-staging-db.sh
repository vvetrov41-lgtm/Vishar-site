#!/usr/bin/env bash
set -euo pipefail

# Guarded retained-staging migration validation. This script applies only 0036,
# proves every pre-existing Telegram row is unchanged, and runs transaction-
# wrapped pgTAP plus lint. It does not deploy a Worker or call Telegram.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly EVIDENCE_DIR="${RUNNER_TEMP:?}/telegram-automatic-drain-db-evidence"
readonly HISTORICAL_IDS=(
  4bf5cb94-60cd-4347-b292-fc0af986fc1f
  bb3c2e92-d8e8-4a54-9c8f-531c058c36bf
  ad5a8e18-b52b-4fd2-ab15-fd5af1f696e1
  7d1e9026-449f-45db-81e9-4aeb2ed0d933
  cec412cf-ecd8-4136-a1ef-c4787457ff6e
  9a776cfb-3cbf-4cac-aaa1-8912e65103a0
  c783e8e2-bc8b-4fcb-a5bf-f685e55fcbba
)
readonly PR189_TARGET_ID="8ac18567-a323-459f-b5a5-9463c0485c6e"
readonly PR190_TARGET_ID="271407db-640d-405b-bc89-4838cf8d56b5"

mkdir -p "$EVIDENCE_DIR"
MIGRATION_ALREADY_APPLIED=false

die() { echo "Telegram automatic drain DB validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/telegram-auto-sql.XXXXXX.json")"
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
  local output="$EVIDENCE_DIR/project.json"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}" > "$output"
  jq -e --arg ref "$PROJECT_REF" '.id == $ref and .status == "ACTIVE_HEALTHY"' \
    "$output" >/dev/null || die "retained staging is not ACTIVE_HEALTHY"
  jq '{id,status,region,database:{version:.database.version}}' "$output" \
    > "$EVIDENCE_DIR/project-safe.json"
  rm -f "$output"
}

write_snapshot() {
  local label="$1" query_file raw_file rollout_expression
  query_file="${RUNNER_TEMP}/telegram-auto-snapshot-${label}.sql"
  raw_file="${RUNNER_TEMP}/telegram-auto-snapshot-${label}.raw.json"
  if [ "$label" = 'before' ] && [ "$MIGRATION_ALREADY_APPLIED" = false ]; then
    rollout_expression="null::jsonb"
  else
    rollout_expression="(select jsonb_build_object('kind', kind, 'automatic_after', automatic_after, 'created_at', created_at) from crm_private.outbox_drain_rollouts where kind = 'telegram_notification')"
  fi
  cat > "$query_file" <<SQL
select jsonb_build_object(
  'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
  'rollout', ${rollout_expression},
  'counts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'artist_id', artist_id, 'status', status, 'count', n
    ) order by artist_id, status)
    from (
      select artist_id, status, count(*)::integer n
      from public.integration_outbox
      where kind = 'telegram_notification'
      group by artist_id, status
    ) x
  ), '[]'::jsonb),
  'integrations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'artist_id', artist_id, 'integration_type', integration_type,
      'provider', provider, 'integration_key', integration_key,
      'is_enabled', is_enabled,
      'external_account_label_md5', md5(coalesce(external_account_label, '')),
      'configuration_md5', md5(configuration::text),
      'created_at', created_at, 'updated_at', updated_at
    ) order by id)
    from public.artist_integrations where integration_type = 'telegram'
  ), '[]'::jsonb),
  'kristina_booking_source', (
    select jsonb_build_object(
      'id', id, 'artist_id', artist_id, 'source_key', source_key,
      'allowed_origin', allowed_origin, 'form_version', form_version,
      'is_active', is_active, 'created_at', created_at, 'updated_at', updated_at
    ) from public.booking_sources where source_key = 'kristina-website'
  ),
  'telegram_rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'artist_id', artist_id, 'enquiry_id', enquiry_id,
      'client_id', client_id, 'kind', kind, 'status', status,
      'attempt_count', attempt_count, 'max_attempts', max_attempts,
      'next_attempt_at', next_attempt_at, 'leased_by', leased_by,
      'leased_at', leased_at, 'lease_expires_at', lease_expires_at,
      'last_error_code', last_error_code, 'payload_md5', md5(payload::text),
      'created_at', created_at, 'updated_at', updated_at
    ) order by id)
    from public.integration_outbox where kind = 'telegram_notification'
  ), '[]'::jsonb)
) as snapshot;
SQL
  sql "$query_file" "$raw_file"
  jq -e 'length == 1 and (.[0].snapshot | type == "object")' "$raw_file" >/dev/null \
    || die "invalid retained-staging snapshot"
  jq -S '.[0].snapshot' "$raw_file" > "$EVIDENCE_DIR/${label}.json"
  rm -f "$query_file" "$raw_file"
}

verify_pre_state() {
  verify_project_health
  write_snapshot before
  jq -e \
    --arg expected_migration "$([ "$MIGRATION_ALREADY_APPLIED" = true ] && printf 0036 || printf 0035)" \
    --argjson migration_already_applied "$MIGRATION_ALREADY_APPLIED" \
    --arg pr189 "$PR189_TARGET_ID" \
    --arg pr190 "$PR190_TARGET_ID" '
    .latest_migration == $expected_migration
    and (if $migration_already_applied then
      .rollout.kind == "telegram_notification"
      and .rollout.automatic_after == .rollout.created_at
      and ((.telegram_rows | map(.created_at) | max) < .rollout.automatic_after)
    else .rollout == null end)
    and .counts == [
      {artist_id:"a1111111-1111-4111-8111-111111111111",status:"succeeded",count:9},
      {artist_id:"a1111111-1111-4111-8111-111111111111",status:"failed",count:7},
      {artist_id:"a2222222-2222-4222-8222-222222222222",status:"succeeded",count:1}
    ]
    and (.integrations | length) == 2
    and any(.integrations[]; .integration_key == "vladimir-staging" and .is_enabled == true)
    and any(.integrations[]; .integration_key == "kristina-staging" and .is_enabled == true)
    and .kristina_booking_source.is_active == false
    and .kristina_booking_source.allowed_origin == null
    and any(.telegram_rows[]; .id == $pr189 and .status == "succeeded")
    and any(.telegram_rows[]; .id == $pr190 and .status == "succeeded")
  ' "$EVIDENCE_DIR/before.json" >/dev/null || die "retained staging pre-state changed"

  for id in "${HISTORICAL_IDS[@]}"; do
    jq -e --arg id "$id" 'any(.telegram_rows[];
      .id == $id and .status == "failed" and .attempt_count == 1
      and .last_error_code == "provider_route_unavailable"
      and .leased_by == null and .leased_at == null and .lease_expires_at == null
    )' "$EVIDENCE_DIR/before.json" >/dev/null \
      || die "historical Telegram fingerprint $id changed"
  done
}

read_migration_versions() {
  local file="$1"
  awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9]{4}$/) print $2}' "$file"
}

prepare_migration_state() {
  supabase link --project-ref "$PROJECT_REF" --password "$STAGING_SUPABASE_DB_PASSWORD"
  supabase migration list --linked > "$EVIDENCE_DIR/migrations-before.txt"
  mapfile -t before_versions < <(read_migration_versions "$EVIDENCE_DIR/migrations-before.txt")
  local expected_count
  case "${#before_versions[@]}:${before_versions[-1]:-}" in
    35:0035)
      MIGRATION_ALREADY_APPLIED=false
      expected_count=35
      ;;
    36:0036)
      MIGRATION_ALREADY_APPLIED=true
      expected_count=36
      ;;
    *)
      die "retained staging migration history is neither exactly 0001 through 0035 nor 0001 through 0036"
      ;;
  esac
  for ((i = 1; i <= expected_count; i += 1)); do
    [ "${before_versions[i - 1]}" = "$(printf '%04d' "$i")" ] \
      || die "retained staging migration history has a gap before 0036"
  done
}

apply_only_0036() {
  if [ "$MIGRATION_ALREADY_APPLIED" = true ]; then
    echo "Migration 0036 is already applied; continuing with unchanged-state proof and hosted validation" \
      | tee "$EVIDENCE_DIR/migration-already-applied.txt"
    return
  fi

  supabase db push --linked --password "$STAGING_SUPABASE_DB_PASSWORD" --dry-run 2>&1 \
    | tee "$EVIDENCE_DIR/migration-dry-run.txt"
  grep -Fq '0036_telegram_outbox_automatic_drain.sql' "$EVIDENCE_DIR/migration-dry-run.txt" \
    || die "dry-run omitted migration 0036"
  if grep -E '00(3[7-9]|[4-9][0-9])_' "$EVIDENCE_DIR/migration-dry-run.txt" >/dev/null; then
    die "dry-run included a migration after 0036"
  fi

  supabase db push --linked --password "$STAGING_SUPABASE_DB_PASSWORD" --yes
  supabase migration list --linked > "$EVIDENCE_DIR/migrations-after.txt"
  mapfile -t after_versions < <(read_migration_versions "$EVIDENCE_DIR/migrations-after.txt")
  [ "${#after_versions[@]}" -eq 36 ] && [ "${after_versions[35]}" = '0036' ] \
    || die "retained staging migration history is not exactly 0001 through 0036"
}

verify_post_state() {
  write_snapshot after
  jq -e '
    .latest_migration == "0036"
    and .rollout.kind == "telegram_notification"
    and .rollout.automatic_after == .rollout.created_at
    and .kristina_booking_source.is_active == false
    and .kristina_booking_source.allowed_origin == null
  ' "$EVIDENCE_DIR/after.json" >/dev/null || die "rollout or booking-source post-state is invalid"

  diff -u \
    <(jq -S '.telegram_rows' "$EVIDENCE_DIR/before.json") \
    <(jq -S '.telegram_rows' "$EVIDENCE_DIR/after.json") >/dev/null \
    || die "migration changed a pre-existing Telegram row"
  diff -u \
    <(jq -S '.counts' "$EVIDENCE_DIR/before.json") \
    <(jq -S '.counts' "$EVIDENCE_DIR/after.json") >/dev/null \
    || die "migration changed Telegram queue counts"
  diff -u \
    <(jq -S '.integrations' "$EVIDENCE_DIR/before.json") \
    <(jq -S '.integrations' "$EVIDENCE_DIR/after.json") >/dev/null \
    || die "migration changed artist Telegram routing"
  diff -u \
    <(jq -S '.kristina_booking_source' "$EVIDENCE_DIR/before.json") \
    <(jq -S '.kristina_booking_source' "$EVIDENCE_DIR/after.json") >/dev/null \
    || die "migration changed the Kristina booking source"

  jq -e '
    (.telegram_rows | map(.created_at) | max) < .rollout.automatic_after
  ' "$EVIDENCE_DIR/after.json" >/dev/null \
    || die "rollout cutoff does not exclude every pre-existing Telegram row"

  supabase test db supabase/tests/191_telegram_automatic_drain.sql --linked 2>&1 \
    | tee "$EVIDENCE_DIR/hosted-pgtap.txt"
  grep -Eq 'Result:[[:space:]]*PASS|All tests successful' "$EVIDENCE_DIR/hosted-pgtap.txt" \
    || die "hosted pgTAP did not pass"
  supabase db lint --linked --schema public,crm_private --level error --fail-on error 2>&1 \
    | tee "$EVIDENCE_DIR/hosted-lint.txt"
  npm run scan:secrets | tee "$EVIDENCE_DIR/final-secret-scan.txt"

  jq -n \
    --arg head_sha "${APPROVED_SHA:?}" \
    --arg cutoff "$(jq -r '.rollout.automatic_after' "$EVIDENCE_DIR/after.json")" '
    {
      project_ref:"gwaliusblwrzisrwnsvs",
      migration_latest:"0036",
      head_sha:$head_sha,
      rollout_cutoff:$cutoff,
      historical_seven_unchanged:true,
      pr189_target_unchanged:true,
      pr190_target_unchanged:true,
      vladimir_route_unchanged:true,
      kristina_route_unchanged:true,
      queue_counts_unchanged:true,
      kristina_booking_source_inactive:true,
      kristina_allowed_origin_null:true,
      worker_deployed:false,
      cron_created:false,
      provider_e2e_executed:false,
      production_targeted:false,
      secret_scan:"passed"
    }
  ' > "$EVIDENCE_DIR/summary.json"
}

for name in SUPABASE_ACCESS_TOKEN STAGING_SUPABASE_DB_PASSWORD SUPABASE_DB_PASSWORD APPROVED_SHA; do
  require_env "$name"
done
[ "${PRODUCTION_TARGETED:-false}" = 'false' ] || die "production target must remain false"

prepare_migration_state
verify_pre_state
apply_only_0036
verify_post_state

echo "Telegram automatic drain migration 0036 retained-staging validation succeeded"
