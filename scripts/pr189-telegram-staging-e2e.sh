#!/usr/bin/env bash
set -euo pipefail

# Guarded retained-staging validation for draft PR #189. The setup inserts one
# explicit synthetic failed Telegram job without a provider call. The only
# provider call is made by workers/lib/telegram-drain.js for that exact UUID.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly STAGING_ORIGIN="https://${PROJECT_REF}.supabase.co"
readonly TARGET_OUTBOX_ID="8ac18567-a323-459f-b5a5-9463c0485c6e"
readonly FIXTURE_ENQUIRY_ID="889f6f13-f317-40c2-aa03-836befb766cb"
readonly FIXTURE_ARTIST_ID="a1111111-1111-4111-8111-111111111111"
readonly ROUTE_BINDING="ARTIST_TELEGRAM_VLADIMIR_HSTAGING"
readonly VALIDATION_MARKER="pr189_exact_id_8ac18567"
readonly DEDUPE_KEY="telegram:validation:pr189:${TARGET_OUTBOX_ID}"
readonly HISTORICAL_IDS=(
  4bf5cb94-60cd-4347-b292-fc0af986fc1f
  bb3c2e92-d8e8-4a54-9c8f-531c058c36bf
  ad5a8e18-b52b-4fd2-ab15-fd5af1f696e1
  7d1e9026-449f-45db-81e9-4aeb2ed0d933
  cec412cf-ecd8-4136-a1ef-c4787457ff6e
  9a776cfb-3cbf-4cac-aaa1-8912e65103a0
  c783e8e2-bc8b-4fcb-a5bf-f685e55fcbba
)

readonly EVIDENCE_DIR="${RUNNER_TEMP:?}/pr189-telegram-evidence"
mkdir -p "$EVIDENCE_DIR"

die() { echo "PR189 staging validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr189-sql.XXXXXX.json")"
  chmod 600 "$request_file"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" > "$output_file"
  rm -f "$request_file"
  jq -e 'type == "array"' "$output_file" >/dev/null || die "hosted SQL response was not a row array"
}

normalise_snapshot() {
  local raw_file="$1" output_file="$2"
  jq -e 'if length == 1 and (.[0].snapshot | type == "object") then true else error("invalid snapshot") end' \
    "$raw_file" >/dev/null
  jq -S '.[0].snapshot' "$raw_file" > "$output_file"
}

write_snapshot() {
  local label="$1" sql_file raw_file
  sql_file="${RUNNER_TEMP}/snapshot-${label}.sql"
  raw_file="${RUNNER_TEMP}/snapshot-${label}.raw.json"
  cat > "$sql_file" <<'SQL'
select jsonb_build_object(
  'counts', jsonb_build_object(
    'succeeded', count(*) filter (where status = 'succeeded'),
    'failed', count(*) filter (where status = 'failed'),
    'pending', count(*) filter (where status = 'pending'),
    'leased', count(*) filter (where status = 'leased'),
    'dead', count(*) filter (where status = 'dead'),
    'total', count(*)
  ),
  'historical', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', h.id,
      'status', h.status,
      'attempt_count', h.attempt_count,
      'max_attempts', h.max_attempts,
      'next_attempt_at', h.next_attempt_at,
      'leased_by', h.leased_by,
      'leased_at', h.leased_at,
      'lease_expires_at', h.lease_expires_at,
      'last_error_code', h.last_error_code,
      'updated_at', h.updated_at
    ) order by h.id)
    from public.integration_outbox h
    where h.id = any(array[
      '4bf5cb94-60cd-4347-b292-fc0af986fc1f'::uuid,
      'bb3c2e92-d8e8-4a54-9c8f-531c058c36bf'::uuid,
      'ad5a8e18-b52b-4fd2-ab15-fd5af1f696e1'::uuid,
      '7d1e9026-449f-45db-81e9-4aeb2ed0d933'::uuid,
      'cec412cf-ecd8-4136-a1ef-c4787457ff6e'::uuid,
      '9a776cfb-3cbf-4cac-aaa1-8912e65103a0'::uuid,
      'c783e8e2-bc8b-4fcb-a5bf-f685e55fcbba'::uuid
    ])
  ), '[]'::jsonb),
  'all_telegram', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'status', o.status,
      'attempt_count', o.attempt_count,
      'max_attempts', o.max_attempts,
      'next_attempt_at', o.next_attempt_at,
      'leased_by', o.leased_by,
      'leased_at', o.leased_at,
      'lease_expires_at', o.lease_expires_at,
      'last_error_code', o.last_error_code,
      'updated_at', o.updated_at
    ) order by o.id)
    from public.integration_outbox o
    where o.kind = 'telegram_notification'
  ), '[]'::jsonb)
) as snapshot
from public.integration_outbox
where kind = 'telegram_notification';
SQL
  sql "$sql_file" "$raw_file"
  normalise_snapshot "$raw_file" "${EVIDENCE_DIR}/${label}.json"
  rm -f "$sql_file" "$raw_file"
}

verify_historical_shape() {
  local snapshot="$1"
  jq -e '
    .historical as $historical
    | ($historical | length) == 7
    and all($historical[];
      .status == "failed"
      and .attempt_count == 1
      and .last_error_code == "provider_route_unavailable"
      and .leased_by == null
      and .leased_at == null
      and .lease_expires_at == null
    )
  ' "$snapshot" >/dev/null || die "historical Telegram failure fingerprint has an unexpected shape"
  for id in "${HISTORICAL_IDS[@]}"; do
    jq -e --arg id "$id" 'any(.historical[]; .id == $id)' "$snapshot" >/dev/null \
      || die "historical Telegram failure $id is absent"
  done
}

verify_pre_state() {
  write_snapshot before
  verify_historical_shape "${EVIDENCE_DIR}/before.json"
  jq -e --arg target "$TARGET_OUTBOX_ID" '
    .counts == {succeeded:8, failed:7, pending:0, leased:0, dead:0, total:15}
    and all(.all_telegram[]; .id != $target)
  ' "${EVIDENCE_DIR}/before.json" >/dev/null \
    || die "retained staging Telegram counts or target absence changed before mutation"

  cat > "${RUNNER_TEMP}/fixture.sql" <<SQL
select jsonb_build_object(
  'fixture_valid',
    e.id = '$FIXTURE_ENQUIRY_ID'::uuid
    and e.artist_id = '$FIXTURE_ARTIST_ID'::uuid
    and e.intake_state = 'complete'
    and e.source = '/booking/'
    and split_part(lower(e.submitted_email), '@', 2) = 'example.invalid'
    and count(f.id) = 1
    and count(f.id) filter (where f.upload_state = 'ready') = 1
    and i.integration_key = 'vladimir-staging'
    and i.provider = 'telegram'
    and i.is_enabled,
  'enquiry_id', e.id,
  'artist_id', e.artist_id,
  'reference_number', e.reference_number,
  'file_count', count(f.id),
  'integration_key', i.integration_key,
  'provider', i.provider
) as fixture
from public.enquiries e
join public.enquiry_files f on f.enquiry_id = e.id
join public.artist_integrations i
  on i.artist_id = e.artist_id and i.integration_type = 'telegram'
where e.id = '$FIXTURE_ENQUIRY_ID'::uuid
group by e.id, e.artist_id, e.intake_state, e.source, e.submitted_email,
         e.reference_number, i.integration_key, i.provider, i.is_enabled;
SQL
  sql "${RUNNER_TEMP}/fixture.sql" "${EVIDENCE_DIR}/fixture.json"
  jq -e 'length == 1 and .[0].fixture.fixture_valid == true' \
    "${EVIDENCE_DIR}/fixture.json" >/dev/null || die "the explicit synthetic fixture is no longer valid"
}

verify_migrations_before() {
  npx --yes supabase@2.111.0 link --project-ref "$PROJECT_REF"
  npx --yes supabase@2.111.0 migration list --linked > "${EVIDENCE_DIR}/migrations-before.txt"
  mapfile -t versions < <(
    awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9]{4}$/) print $2}' \
      "${EVIDENCE_DIR}/migrations-before.txt"
  )
  [ "${#versions[@]}" -eq 34 ] || die "retained staging must contain exactly migrations 0001 through 0034"
  for n in $(seq -w 1 34); do
    printf '%s\n' "${versions[@]}" | grep -Fxq "00$n" || die "remote migration 00$n is absent"
  done
}

apply_exact_migration() {
  npx --yes supabase@2.111.0 db push --linked --dry-run 2>&1 \
    | tee "${EVIDENCE_DIR}/migration-dry-run.txt"
  grep -Fq '0035_telegram_outbox_exact_id_drain.sql' "${EVIDENCE_DIR}/migration-dry-run.txt" \
    || die "dry-run omitted migration 0035"
  if grep -E '00(3[6-9]|[4-9][0-9])_' "${EVIDENCE_DIR}/migration-dry-run.txt" >/dev/null; then
    die "dry-run contained a migration beyond 0035"
  fi
  npx --yes supabase@2.111.0 db push --linked --yes
  npx --yes supabase@2.111.0 migration list --linked > "${EVIDENCE_DIR}/migrations-after.txt"
  mapfile -t versions < <(
    awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9]{4}$/) print $2}' \
      "${EVIDENCE_DIR}/migrations-after.txt"
  )
  [ "${#versions[@]}" -eq 35 ] || die "retained staging must contain exactly migrations 0001 through 0035"
  [ "${versions[34]}" = '0035' ] || die "retained staging latest migration is not 0035"

  write_snapshot after-migration
  diff -u "${EVIDENCE_DIR}/before.json" "${EVIDENCE_DIR}/after-migration.json" >/dev/null \
    || die "migration 0035 unexpectedly changed Telegram outbox state"

  npx --yes supabase@2.111.0 test db --linked 2>&1 | tee "${EVIDENCE_DIR}/hosted-pgtap.txt"
  grep -Eq 'Result:[[:space:]]*PASS|All tests successful' "${EVIDENCE_DIR}/hosted-pgtap.txt" \
    || die "hosted pgTAP did not pass"
  npx --yes supabase@2.111.0 db lint --linked --schema public,crm_private --level error --fail-on error \
    2>&1 | tee "${EVIDENCE_DIR}/hosted-lint.txt"
}

create_one_synthetic_failed_job() {
  cat > "${RUNNER_TEMP}/setup.sql" <<SQL
do \$setup\$
declare
  v_rows integer;
begin
  if exists (select 1 from public.integration_outbox where id = '$TARGET_OUTBOX_ID'::uuid) then
    raise exception 'PR189 target already exists';
  end if;

  insert into public.integration_outbox (
    id, artist_id, kind, dedupe_key, status, payload,
    client_id, enquiry_id, attempt_count, max_attempts,
    next_attempt_at, last_error_code
  )
  select
    '$TARGET_OUTBOX_ID'::uuid,
    e.artist_id,
    'telegram_notification'::public.outbox_kind,
    '$DEDUPE_KEY',
    'failed'::public.outbox_status,
    jsonb_build_object('enquiry_id', e.id, 'validation_marker', '$VALIDATION_MARKER'),
    e.client_id,
    e.id,
    1,
    8,
    now() - interval '1 minute',
    'synthetic_retry_setup'
  from public.enquiries e
  where e.id = '$FIXTURE_ENQUIRY_ID'::uuid
    and e.artist_id = '$FIXTURE_ARTIST_ID'::uuid
    and e.intake_state = 'complete'
    and e.source = '/booking/'
    and split_part(lower(e.submitted_email), '@', 2) = 'example.invalid'
    and exists (
      select 1 from public.artist_integrations i
      where i.artist_id = e.artist_id
        and i.integration_type = 'telegram'
        and i.provider = 'telegram'
        and i.integration_key = 'vladimir-staging'
        and i.is_enabled
    )
    and (select count(*) from public.enquiry_files f where f.enquiry_id = e.id) = 1
    and (select count(*) from public.enquiry_files f
         where f.enquiry_id = e.id and f.upload_state = 'ready') = 1;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'PR189 setup did not insert exactly one target job';
  end if;
end
\$setup\$;

select jsonb_build_object(
  'outbox_id', id,
  'kind', kind,
  'status', status,
  'attempt_count', attempt_count,
  'max_attempts', max_attempts,
  'due', next_attempt_at <= now(),
  'last_error_code', last_error_code,
  'lease_clear', leased_by is null and leased_at is null and lease_expires_at is null,
  'validation_marker', payload ->> 'validation_marker'
) as target
from public.integration_outbox
where id = '$TARGET_OUTBOX_ID'::uuid;
SQL
  sql "${RUNNER_TEMP}/setup.sql" "${EVIDENCE_DIR}/target-before.json"
  jq -e --arg id "$TARGET_OUTBOX_ID" --arg marker "$VALIDATION_MARKER" '
    length == 1
    and .[0].target.outbox_id == $id
    and .[0].target.kind == "telegram_notification"
    and .[0].target.status == "failed"
    and .[0].target.attempt_count == 1
    and .[0].target.due == true
    and .[0].target.lease_clear == true
    and .[0].target.validation_marker == $marker
  ' "${EVIDENCE_DIR}/target-before.json" >/dev/null \
    || die "the one synthetic target job was not prepared exactly"

  write_snapshot after-setup
  verify_historical_shape "${EVIDENCE_DIR}/after-setup.json"
  diff -u \
    <(jq -S '.historical' "${EVIDENCE_DIR}/before.json") \
    <(jq -S '.historical' "${EVIDENCE_DIR}/after-setup.json") >/dev/null \
    || die "a historical Telegram failure changed during setup"
  jq -e '
    .counts == {succeeded:8, failed:8, pending:0, leased:0, dead:0, total:16}
  ' "${EVIDENCE_DIR}/after-setup.json" >/dev/null \
    || die "setup changed more than the one target Telegram job"
}

run_exact_drain() {
  local binding_file worker_id
  binding_file="$(mktemp "${RUNNER_TEMP}/pr189-provider-binding.XXXXXX.json")"
  chmod 600 "$binding_file"
  jq -n --arg bot "$TELEGRAM_BOT_TOKEN" --arg chat "$TELEGRAM_CHAT_ID" \
    '{botToken:$bot,chatId:$chat}' > "$binding_file"

  export ARTIST_TELEGRAM_VLADIMIR_HSTAGING
  ARTIST_TELEGRAM_VLADIMIR_HSTAGING="$(jq -c . "$binding_file")"
  rm -f "$binding_file"
  unset TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID

  worker_id="telegram-pr189-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
  export TARGET_OUTBOX_ID ROUTE_BINDING worker_id EVIDENCE_DIR
  node --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';
import { drainTelegramOutboxById } from './workers/lib/telegram-drain.js';

const bindingName = process.env.ROUTE_BINDING;
const env = {
  SUPABASE_URL: process.env.STAGING_SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  [bindingName]: process.env[bindingName],
};
const result = await drainTelegramOutboxById(env, {
  outboxId: process.env.TARGET_OUTBOX_ID,
  workerId: process.env.worker_id,
  leaseSeconds: 120,
});
if (result?.claimed !== true || result?.outcome !== 'succeeded') {
  throw new Error(`exact Telegram drain did not succeed: ${result?.outcome ?? 'unknown'}`);
}
await writeFile(
  `${process.env.EVIDENCE_DIR}/drain-result.json`,
  `${JSON.stringify({ ...result, providerDelivery: true }, null, 2)}\n`,
  { mode: 0o600 },
);
NODE
  unset ARTIST_TELEGRAM_VLADIMIR_HSTAGING worker_id
}

verify_post_state() {
  cat > "${RUNNER_TEMP}/target-after.sql" <<SQL
select jsonb_build_object(
  'outbox_id', o.id,
  'status', o.status,
  'attempt_count', o.attempt_count,
  'last_error_code', o.last_error_code,
  'lease_clear', o.leased_by is null and o.leased_at is null and o.lease_expires_at is null,
  'success_activity_count', count(a.id) filter (where a.event_type = 'outbox.succeeded'),
  'lease_aware_activity', bool_or(
    a.event_type = 'outbox.succeeded' and a.metadata ->> 'lease_aware' = 'true'
  )
) as target
from public.integration_outbox o
left join public.activity_log a on a.outbox_id = o.id
where o.id = '$TARGET_OUTBOX_ID'::uuid
group by o.id, o.status, o.attempt_count, o.last_error_code,
         o.leased_by, o.leased_at, o.lease_expires_at;
SQL
  sql "${RUNNER_TEMP}/target-after.sql" "${EVIDENCE_DIR}/target-after.json"
  jq -e --arg id "$TARGET_OUTBOX_ID" '
    length == 1
    and .[0].target.outbox_id == $id
    and .[0].target.status == "succeeded"
    and .[0].target.attempt_count == 2
    and .[0].target.last_error_code == null
    and .[0].target.lease_clear == true
    and .[0].target.success_activity_count == 1
    and .[0].target.lease_aware_activity == true
  ' "${EVIDENCE_DIR}/target-after.json" >/dev/null \
    || die "target was not acknowledged as one successful retry"

  write_snapshot after
  verify_historical_shape "${EVIDENCE_DIR}/after.json"
  diff -u \
    <(jq -S '.historical' "${EVIDENCE_DIR}/before.json") \
    <(jq -S '.historical' "${EVIDENCE_DIR}/after.json") >/dev/null \
    || die "a historical Telegram failure changed; no further drain is permitted"
  diff -u \
    <(jq -S '.all_telegram' "${EVIDENCE_DIR}/before.json") \
    <(jq -S --arg target "$TARGET_OUTBOX_ID" \
       '[.all_telegram[] | select(.id != $target)]' "${EVIDENCE_DIR}/after.json") >/dev/null \
    || die "a non-target Telegram outbox job changed"
  jq -e '
    .counts == {succeeded:9, failed:7, pending:0, leased:0, dead:0, total:16}
  ' "${EVIDENCE_DIR}/after.json" >/dev/null \
    || die "post-drain Telegram counts are not isolated to the target"

  npx --yes supabase@2.111.0 migration list --linked > "${EVIDENCE_DIR}/migrations-final.txt"
  mapfile -t versions < <(
    awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9]{4}$/) print $2}' \
      "${EVIDENCE_DIR}/migrations-final.txt"
  )
  [ "${#versions[@]}" -eq 35 ] && [ "${versions[34]}" = '0035' ] \
    || die "final retained staging migration history is not 0001 through 0035"

  npm run scan:secrets | tee "${EVIDENCE_DIR}/final-secret-scan.txt"
  jq -n \
    --arg outbox_id "$TARGET_OUTBOX_ID" \
    --arg head_sha "${APPROVED_SHA:?}" \
    '{
      project_ref:"gwaliusblwrzisrwnsvs",
      migration_latest:"0035",
      head_sha:$head_sha,
      target_outbox_id:$outbox_id,
      target_before:{status:"failed",attempt_count:1},
      target_after:{status:"succeeded",attempt_count:2,last_error_code:null,lease_clear:true},
      provider_delivery:true,
      historical_failures_unchanged:true,
      all_other_telegram_jobs_unchanged:true,
      production_targeted:false,
      secret_scan:"passed"
    }' > "${EVIDENCE_DIR}/summary.json"
}

for name in SUPABASE_ACCESS_TOKEN STAGING_SUPABASE_DB_PASSWORD SUPABASE_DB_PASSWORD \
  STAGING_SUPABASE_URL SUPABASE_SECRET_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID APPROVED_SHA; do
  require_env "$name"
done
[ "$STAGING_SUPABASE_URL" = "$STAGING_ORIGIN" ] || die "Supabase target is not retained staging"
[ "${PRODUCTION_TARGETED:-false}" = 'false' ] || die "production target must remain false"

verify_migrations_before
verify_pre_state
apply_exact_migration
create_one_synthetic_failed_job
run_exact_drain
verify_post_state

echo "PR189 exact-ID Telegram staging E2E succeeded for ${TARGET_OUTBOX_ID}"
