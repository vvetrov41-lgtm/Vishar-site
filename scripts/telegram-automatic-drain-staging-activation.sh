#!/usr/bin/env bash
set -euo pipefail

# Guarded retained-staging activation for draft PR #191. This script creates
# one scheduled-only Worker, provisions exactly two artist-scoped bindings,
# inserts two post-cutoff synthetic failed jobs and waits for one bounded claim
# batch to deliver and acknowledge both. Production is never targeted.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly STAGING_ORIGIN="https://${PROJECT_REF}.supabase.co"
readonly WORKER_NAME="vishar-telegram-drain-staging"
readonly CRON="*/5 * * * *"
readonly VLADIMIR_ARTIST_ID="a1111111-1111-4111-8111-111111111111"
readonly KRISTINA_ARTIST_ID="a2222222-2222-4222-8222-222222222222"
readonly VLADIMIR_ENQUIRY_ID="889f6f13-f317-40c2-aa03-836befb766cb"
readonly KRISTINA_ENQUIRY_ID="72e570f3-b767-45da-a74c-2872b910be9d"
readonly VLADIMIR_TARGET_ID="7b1f4d9a-6c21-4e88-91d3-9b2026081101"
readonly KRISTINA_TARGET_ID="8c2e5fab-7d32-4f99-a2e4-ac2026081102"
readonly PR189_TARGET_ID="8ac18567-a323-459f-b5a5-9463c0485c6e"
readonly PR190_TARGET_ID="271407db-640d-405b-bc89-4838cf8d56b5"
readonly VLADIMIR_BINDING="ARTIST_TELEGRAM_VLADIMIR_HSTAGING"
readonly KRISTINA_BINDING="ARTIST_TELEGRAM_KRISTINA_HSTAGING"
readonly HISTORICAL_IDS=(
  4bf5cb94-60cd-4347-b292-fc0af986fc1f
  bb3c2e92-d8e8-4a54-9c8f-531c058c36bf
  ad5a8e18-b52b-4fd2-ab15-fd5af1f696e1
  7d1e9026-449f-45db-81e9-4aeb2ed0d933
  cec412cf-ecd8-4136-a1ef-c4787457ff6e
  9a776cfb-3cbf-4cac-aaa1-8912e65103a0
  c783e8e2-bc8b-4fcb-a5bf-f685e55fcbba
)
readonly EVIDENCE_DIR="${RUNNER_TEMP:?}/telegram-automatic-drain-activation-evidence"

mkdir -p "$EVIDENCE_DIR"

die() { echo "Telegram automatic drain activation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/telegram-activation-sql.XXXXXX.json")"
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

write_snapshot() {
  local label="$1" query_file raw_file
  query_file="${RUNNER_TEMP}/telegram-activation-${label}.sql"
  raw_file="${RUNNER_TEMP}/telegram-activation-${label}.raw.json"
  cat > "$query_file" <<'SQL'
select jsonb_build_object(
  'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
  'rollout', (
    select jsonb_build_object('kind', kind, 'automatic_after', automatic_after, 'created_at', created_at)
    from crm_private.outbox_drain_rollouts where kind = 'telegram_notification'
  ),
  'counts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'artist_id', artist_id, 'status', status, 'count', n
    ) order by artist_id, status)
    from (
      select artist_id, status, count(*)::integer n
      from public.integration_outbox where kind = 'telegram_notification'
      group by artist_id, status
    ) c
  ), '[]'::jsonb),
  'eligible', (
    select count(*)::integer
    from public.integration_outbox o
    join crm_private.outbox_drain_rollouts r on r.kind = o.kind
    where o.kind = 'telegram_notification'
      and o.created_at >= r.automatic_after
      and o.attempt_count < o.max_attempts
      and (
        (o.status in ('pending', 'failed') and o.next_attempt_at <= now())
        or (o.status = 'leased' and o.lease_expires_at <= now())
      )
  ),
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
  ), '[]'::jsonb),
  'target_activities', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'event_type', event_type, 'outbox_id', outbox_id,
      'artist_id', artist_id, 'enquiry_id', enquiry_id,
      'metadata', metadata, 'created_at', created_at
    ) order by created_at, id)
    from public.activity_log
    where outbox_id in (
      '7b1f4d9a-6c21-4e88-91d3-9b2026081101'::uuid,
      '8c2e5fab-7d32-4f99-a2e4-ac2026081102'::uuid
    )
  ), '[]'::jsonb)
) as snapshot;
SQL
  sql "$query_file" "$raw_file"
  jq -e 'length == 1 and (.[0].snapshot | type == "object")' "$raw_file" >/dev/null \
    || die "invalid retained-staging snapshot"
  jq -S '.[0].snapshot' "$raw_file" > "$EVIDENCE_DIR/${label}.json"
  rm -f "$query_file" "$raw_file"
}

verify_project_and_pre_state() {
  local raw_project="$RUNNER_TEMP/telegram-project.json"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}" > "$raw_project"
  jq -e --arg ref "$PROJECT_REF" '.id == $ref and .status == "ACTIVE_HEALTHY"' \
    "$raw_project" >/dev/null || die "retained staging is not ACTIVE_HEALTHY"
  jq '{id,status,region,database:{version:.database.version}}' "$raw_project" \
    > "$EVIDENCE_DIR/project-before.json"
  rm -f "$raw_project"

  write_snapshot before
  jq -e \
    --arg vladimir "$VLADIMIR_TARGET_ID" \
    --arg kristina "$KRISTINA_TARGET_ID" \
    --arg pr189 "$PR189_TARGET_ID" \
    --arg pr190 "$PR190_TARGET_ID" '
    .latest_migration == "0036"
    and .rollout.kind == "telegram_notification"
    and .rollout.automatic_after == .rollout.created_at
    and (.telegram_rows | length) == 17
    and .counts == [
      {artist_id:"a1111111-1111-4111-8111-111111111111",status:"succeeded",count:9},
      {artist_id:"a1111111-1111-4111-8111-111111111111",status:"failed",count:7},
      {artist_id:"a2222222-2222-4222-8222-222222222222",status:"succeeded",count:1}
    ]
    and .eligible == 0
    and (.integrations | length) == 2
    and any(.integrations[]; .artist_id == "a1111111-1111-4111-8111-111111111111" and .integration_key == "vladimir-staging" and .is_enabled == true)
    and any(.integrations[]; .artist_id == "a2222222-2222-4222-8222-222222222222" and .integration_key == "kristina-staging" and .is_enabled == true)
    and .kristina_booking_source.is_active == false
    and .kristina_booking_source.allowed_origin == null
    and any(.telegram_rows[]; .id == $pr189 and .status == "succeeded")
    and any(.telegram_rows[]; .id == $pr190 and .status == "succeeded")
    and all(.telegram_rows[]; .id != $vladimir and .id != $kristina)
    and .target_activities == []
  ' "$EVIDENCE_DIR/before.json" >/dev/null || die "retained staging pre-state changed"
  for id in "${HISTORICAL_IDS[@]}"; do
    jq -e --arg id "$id" 'any(.telegram_rows[];
      .id == $id and .artist_id == "a1111111-1111-4111-8111-111111111111"
      and .status == "failed" and .attempt_count == 1
      and .last_error_code == "provider_route_unavailable"
      and .leased_by == null and .leased_at == null and .lease_expires_at == null
    )' "$EVIDENCE_DIR/before.json" >/dev/null \
      || die "historical Telegram fingerprint $id changed before activation"
  done
}

inspect_cloudflare_cost_and_name() {
  local api="https://api.cloudflare.com/client/v4"
  local subscription_raw="$RUNNER_TEMP/cloudflare-subscriptions.raw.json"
  local subscription_status usage_raw usage_status settings_raw settings_status

  subscription_status="$(curl --silent --show-error -o "$subscription_raw" -w '%{http_code}' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/subscriptions" || true)"
  if [ "$subscription_status" = 200 ] && jq -e '.success == true and (.result | type == "array")' "$subscription_raw" >/dev/null; then
    jq '{available:true,subscriptions:[.result[]|{
      state,price,currency,frequency,
      rate_plan:{id:.rate_plan.id,public_name:.rate_plan.public_name,scope:.rate_plan.scope}
    }]}' "$subscription_raw" > "$EVIDENCE_DIR/cloudflare-plan.json"
  else
    jq -n --arg status "$subscription_status" '{available:false,http_status:$status}' \
      > "$EVIDENCE_DIR/cloudflare-plan.json"
  fi
  rm -f "$subscription_raw"

  usage_raw="$RUNNER_TEMP/cloudflare-workers-usage.raw.json"
  export usage_raw
  usage_status="$(python3 - <<'PY'
import json, os
from datetime import datetime, timezone
from pathlib import Path
import urllib.request

now = datetime.now(timezone.utc)
start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
payload = {
    'query': '''query WorkersUsage($accountTag: string, $datetimeStart: string, $datetimeEnd: string) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        workersInvocationsAdaptive(limit: 10000, filter: {
          datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd
        }) {
          dimensions { scriptName }
          sum { requests errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 }
        }
      } }
    }''',
    'variables': {
        'accountTag': os.environ['CLOUDFLARE_ACCOUNT_ID'],
        'datetimeStart': start.isoformat().replace('+00:00', 'Z'),
        'datetimeEnd': now.isoformat().replace('+00:00', 'Z'),
    },
}
request = urllib.request.Request(
    'https://api.cloudflare.com/client/v4/graphql',
    data=json.dumps(payload).encode(), method='POST',
    headers={
        'Authorization': f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    },
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        Path(os.environ['usage_raw']).write_bytes(response.read())
        print(response.status)
except Exception as exc:
    status = getattr(exc, 'code', 0)
    body = getattr(exc, 'read', lambda: b'{}')()
    Path(os.environ['usage_raw']).write_bytes(body or b'{}')
    print(status)
PY
)"
  if [ "$usage_status" = 200 ] && jq -e '.data.viewer.accounts[0].workersInvocationsAdaptive | type == "array"' "$usage_raw" >/dev/null 2>&1; then
    jq '{
      available:true,
      scripts:[.data.viewer.accounts[0].workersInvocationsAdaptive[]|{
        script_name:.dimensions.scriptName,
        requests:(.sum.requests // 0),errors:(.sum.errors // 0),subrequests:(.sum.subrequests // 0),
        cpu_time_p50:(.quantiles.cpuTimeP50 // null),cpu_time_p99:(.quantiles.cpuTimeP99 // null)
      }],
      total_requests:([.data.viewer.accounts[0].workersInvocationsAdaptive[].sum.requests // 0] | add // 0)
    }' "$usage_raw" > "$EVIDENCE_DIR/cloudflare-usage.json"
  else
    jq -n --arg status "$usage_status" '{available:false,http_status:$status}' \
      > "$EVIDENCE_DIR/cloudflare-usage.json"
  fi
  rm -f "$usage_raw"

  settings_raw="$RUNNER_TEMP/cloudflare-worker-settings-before.json"
  settings_status="$(curl --silent --show-error -o "$settings_raw" -w '%{http_code}' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/settings" || true)"
  if [ "$settings_status" = 404 ]; then
    jq -n --arg worker "$WORKER_NAME" '{worker_name:$worker,name_conflict:false,preexisting:false,partial_cleanup:false}' \
      > "$EVIDENCE_DIR/cloudflare-resource-before.json"
  elif [ "$settings_status" = 200 ]; then
    jq -e '
      .success == true
      and any(.result.bindings[]?; .name == "TELEGRAM_DRAIN_ENABLED" and .type == "plain_text" and .text == "false")
      and ([.result.bindings[]? | select(.type == "secret_text" or .type == "secret") | .name] | sort)
        == ["ARTIST_TELEGRAM_KRISTINA_HSTAGING", "ARTIST_TELEGRAM_VLADIMIR_HSTAGING", "SUPABASE_SECRET_KEY"]
      and (any(.result.bindings[]?; .name == "VISHAR_ACTIVATION_SHA") | not)
    ' "$settings_raw" >/dev/null \
      || die "Cloudflare Worker name is occupied by a non-matching or enabled runtime"
    verify_schedule none
    curl --fail --silent --show-error -X DELETE \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME" >/dev/null \
      || die "failed to delete the previous disabled PR191 Worker"
    for attempt in $(seq 1 20); do
      settings_status="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/settings" || true)"
      [ "$settings_status" = 404 ] && break
      sleep 2
    done
    [ "$settings_status" = 404 ] || die "previous disabled PR191 Worker still exists after delete"
    jq -n --arg worker "$WORKER_NAME" '{worker_name:$worker,name_conflict:false,preexisting:false,partial_cleanup:true}' \
      > "$EVIDENCE_DIR/cloudflare-resource-before.json"
  else
    die "Cloudflare Worker name check failed (HTTP $settings_status)"
  fi
  rm -f "$settings_raw"
}

prepare_secrets_and_preflight() {
  local secrets_file="$1"
  export secrets_file
  python3 - <<'PY'
import json, os, re
from pathlib import Path

values = {}
for prefix, token_name, chat_name in (
    ('ARTIST_TELEGRAM_VLADIMIR_HSTAGING', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'),
    ('ARTIST_TELEGRAM_KRISTINA_HSTAGING', 'KRISTINA_TELEGRAM_BOT_TOKEN', 'KRISTINA_TELEGRAM_CHAT_ID'),
):
    token = os.environ[token_name].strip()
    chat_id = os.environ[chat_name].strip()
    if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', token):
        raise SystemExit(f'{token_name} has an unexpected format')
    if not re.fullmatch(r'-?[0-9]+', chat_id):
        raise SystemExit(f'{chat_name} has an unexpected format')
    values[prefix] = json.dumps({'botToken': token, 'chatId': chat_id}, separators=(',', ':'))
values['SUPABASE_SECRET_KEY'] = os.environ['SUPABASE_SECRET_KEY']
path = Path(os.environ['secrets_file'])
path.write_text(json.dumps(values), encoding='utf-8')
path.chmod(0o600)
PY

  PREFLIGHT_EVIDENCE_PATH="$EVIDENCE_DIR/provider-preflight.json" \
  STAGING_SUPABASE_URL="$STAGING_SUPABASE_URL" \
  SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" \
  ARTIST_TELEGRAM_VLADIMIR_HSTAGING="$(jq -r --arg name "$VLADIMIR_BINDING" '.[$name]' "$secrets_file")" \
  ARTIST_TELEGRAM_KRISTINA_HSTAGING="$(jq -r --arg name "$KRISTINA_BINDING" '.[$name]' "$secrets_file")" \
  env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CHAT_ID \
    -u KRISTINA_TELEGRAM_BOT_TOKEN -u KRISTINA_TELEGRAM_CHAT_ID \
    node scripts/run-telegram-automatic-drain-preflight.mjs
}

verify_schedule() {
  local expected="$1" response="$RUNNER_TEMP/cloudflare-schedules.json"
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/schedules" \
    > "$response"
  if [ "$expected" = none ]; then
    jq -e '
      .success == true
      and (if (.result | type) == "array" then .result == []
           elif (.result.schedules | type) == "array" then .result.schedules == []
           else false end)
    ' "$response" >/dev/null || die "disabled Worker unexpectedly has a schedule"
  else
    jq -e --arg cron "$CRON" '
      def crons:
        if (.result | type) == "array" then [.result[] | .cron]
        elif (.result.schedules | type) == "array" then [.result.schedules[] | .cron]
        else [] end;
      .success == true and crons == [$cron]
    ' "$response" >/dev/null || die "expected Telegram drain schedule is absent"
    jq -n --arg cron "$CRON" '{verified:true,crons:[$cron]}' \
      > "$EVIDENCE_DIR/cloudflare-schedule.json"
  fi
  rm -f "$response"
}

deploy_disabled_worker() {
  local secrets_file="$1" dry_run_dir="$RUNNER_TEMP/telegram-disabled-dry-run"
  rm -rf "$dry_run_dir"
  npx wrangler deploy --config wrangler.telegram-drain.staging.toml \
    --dry-run --outdir "$dry_run_dir"
  npx wrangler deploy --config wrangler.telegram-drain.staging.toml \
    --keep-vars --secrets-file "$secrets_file" \
    --message "PR191 disabled staging deploy ${APPROVED_SHA}"
  rm -rf "$dry_run_dir"
  verify_schedule none
}

create_two_post_cutoff_jobs() {
  local setup_file="$RUNNER_TEMP/telegram-activation-setup.sql"
  local setup_raw="$RUNNER_TEMP/telegram-activation-setup.raw.json"
  cat > "$setup_file" <<SQL
do \$setup\$
declare
  v_rows integer;
begin
  if exists (
    select 1 from public.integration_outbox
    where id in ('$VLADIMIR_TARGET_ID'::uuid, '$KRISTINA_TARGET_ID'::uuid)
  ) then
    raise exception 'PR191 automatic-drain target already exists';
  end if;

  insert into public.integration_outbox (
    id, artist_id, kind, dedupe_key, status, payload,
    client_id, enquiry_id, attempt_count, max_attempts,
    next_attempt_at, last_error_code
  )
  select
    '$VLADIMIR_TARGET_ID'::uuid, e.artist_id, 'telegram_notification',
    'telegram:validation:pr191-auto-vladimir:$VLADIMIR_TARGET_ID',
    'failed', jsonb_build_object('enquiry_id', e.id, 'validation_marker', 'pr191_auto_vladimir'),
    e.client_id, e.id, 1, 8, now() - interval '1 minute', 'synthetic_initial_failure'
  from public.enquiries e
  where e.id = '$VLADIMIR_ENQUIRY_ID'::uuid
    and e.artist_id = '$VLADIMIR_ARTIST_ID'::uuid
    and e.intake_state = 'complete'
    and split_part(lower(e.submitted_email), '@', 2) = 'example.invalid'
    and (select count(*) from public.enquiry_files f where f.enquiry_id = e.id) = 1
    and (select count(*) from public.enquiry_files f where f.enquiry_id = e.id and f.upload_state = 'ready') = 1;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'Vladimir PR191 target setup failed'; end if;

  insert into public.integration_outbox (
    id, artist_id, kind, dedupe_key, status, payload,
    client_id, enquiry_id, attempt_count, max_attempts,
    next_attempt_at, last_error_code
  )
  select
    '$KRISTINA_TARGET_ID'::uuid, e.artist_id, 'telegram_notification',
    'telegram:validation:pr191-auto-kristina:$KRISTINA_TARGET_ID',
    'failed', jsonb_build_object('enquiry_id', e.id, 'validation_marker', 'pr191_auto_kristina'),
    e.client_id, e.id, 1, 8, now() - interval '1 minute', 'synthetic_initial_failure'
  from public.enquiries e
  where e.id = '$KRISTINA_ENQUIRY_ID'::uuid
    and e.artist_id = '$KRISTINA_ARTIST_ID'::uuid
    and e.intake_state = 'complete'
    and split_part(lower(e.submitted_email), '@', 2) = 'example.invalid'
    and (select count(*) from public.enquiry_files f where f.enquiry_id = e.id) = 1
    and (select count(*) from public.enquiry_files f where f.enquiry_id = e.id and f.upload_state = 'ready') = 1;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'Kristina PR191 target setup failed'; end if;

  if exists (
    select 1 from public.integration_outbox o
    join crm_private.outbox_drain_rollouts r on r.kind = o.kind
    where o.id in ('$VLADIMIR_TARGET_ID'::uuid, '$KRISTINA_TARGET_ID'::uuid)
      and o.created_at < r.automatic_after
  ) then
    raise exception 'PR191 target is before rollout cutoff';
  end if;
end
\$setup\$;
select jsonb_build_object('inserted', count(*), 'eligible', count(*) filter (
  where status = 'failed' and next_attempt_at <= now()
)) as setup
from public.integration_outbox
where id in ('$VLADIMIR_TARGET_ID'::uuid, '$KRISTINA_TARGET_ID'::uuid);
SQL
  sql "$setup_file" "$setup_raw"
  jq -e 'length == 1 and .[0].setup == {inserted:2,eligible:2}' "$setup_raw" >/dev/null \
    || die "two-job setup evidence is invalid"
  jq '.[0].setup' "$setup_raw" > "$EVIDENCE_DIR/setup.json"
  rm -f "$setup_file" "$setup_raw"

  write_snapshot after-setup
  diff -u \
    <(jq -S '.telegram_rows' "$EVIDENCE_DIR/before.json") \
    <(jq -S --arg v "$VLADIMIR_TARGET_ID" --arg k "$KRISTINA_TARGET_ID" \
      '.telegram_rows | map(select(.id != $v and .id != $k))' "$EVIDENCE_DIR/after-setup.json") >/dev/null \
    || die "setup changed a pre-existing Telegram row"
  jq -e --arg v "$VLADIMIR_TARGET_ID" --arg k "$KRISTINA_TARGET_ID" '
    (.telegram_rows | length) == 19 and .eligible == 2
    and all(.telegram_rows[] | select(.id == $v or .id == $k);
      .status == "failed" and .attempt_count == 1
      and .last_error_code == "synthetic_initial_failure"
      and .leased_by == null and .leased_at == null and .lease_expires_at == null
    )
  ' "$EVIDENCE_DIR/after-setup.json" >/dev/null || die "post-cutoff targets are not safely due"
}

deploy_enabled_worker_and_cron() {
  local secrets_file="$1" deploy_config="$PWD/wrangler.telegram-drain.activation.toml"
  local dry_run_dir="$RUNNER_TEMP/telegram-enabled-dry-run"
  export deploy_config
  python3 - <<'PY'
import os, re
from pathlib import Path

source = Path('wrangler.telegram-drain.staging.toml').read_text(encoding='utf-8')
if source.count('TELEGRAM_DRAIN_ENABLED = "false"') != 1:
    raise SystemExit('Expected one disabled Telegram drain flag')
if re.search(r'^\[triggers\]$', source, re.M) or re.search(r'^crons\s*=', source, re.M):
    raise SystemExit('Base Telegram drain config unexpectedly contains a trigger')
if re.search(r'^routes\s*=|^route\s*=', source, re.M) or 'custom_domain' in source:
    raise SystemExit('Base Telegram drain config unexpectedly contains a route')
activated = source.replace(
    'TELEGRAM_DRAIN_ENABLED = "false"',
    f'TELEGRAM_DRAIN_ENABLED = "true"\nVISHAR_ACTIVATION_SHA = "{os.environ["APPROVED_SHA"]}"',
)
activated = activated.rstrip() + '\n\n[triggers]\ncrons = ["*/5 * * * *"]\n'
Path(os.environ['deploy_config']).write_text(activated, encoding='utf-8')
PY
  grep -Fx 'workers_dev = false' "$deploy_config"
  grep -Fx 'TELEGRAM_DRAIN_ENABLED = "true"' "$deploy_config"
  grep -Fx "VISHAR_ACTIVATION_SHA = \"$APPROVED_SHA\"" "$deploy_config"
  grep -Fx '[triggers]' "$deploy_config"
  grep -Fx 'crons = ["*/5 * * * *"]' "$deploy_config"
  ! grep -Eq '^routes\s*=|^route\s*=|custom_domain' "$deploy_config"

  rm -rf "$dry_run_dir"
  npx wrangler deploy --config "$deploy_config" --dry-run --outdir "$dry_run_dir"
  npx wrangler deploy --config "$deploy_config" \
    --keep-vars --secrets-file "$secrets_file" \
    --message "PR191 enabled staging cron ${APPROVED_SHA}"
  rm -rf "$dry_run_dir"
  verify_schedule enabled
}

wait_for_one_claiming_invocation() {
  local poll_file="$RUNNER_TEMP/telegram-activation-poll.sql"
  local poll_raw="$RUNNER_TEMP/telegram-activation-poll.raw.json"
  cat > "$poll_file" <<SQL
select jsonb_build_object(
  'targets', coalesce((select jsonb_agg(jsonb_build_object(
    'id', id, 'status', status, 'attempt_count', attempt_count,
    'last_error_code', last_error_code, 'leased_by', leased_by
  ) order by id) from public.integration_outbox
  where id in ('$VLADIMIR_TARGET_ID'::uuid, '$KRISTINA_TARGET_ID'::uuid)), '[]'::jsonb),
  'success_activity_count', (select count(*) from public.activity_log
    where outbox_id in ('$VLADIMIR_TARGET_ID'::uuid, '$KRISTINA_TARGET_ID'::uuid)
      and event_type = 'outbox.succeeded')
) as state;
SQL
  for attempt in $(seq 1 100); do
    sql "$poll_file" "$poll_raw"
    if jq -e '
      length == 1
      and (.[0].state.targets | length) == 2
      and all(.[0].state.targets[];
        .status == "succeeded" and .attempt_count == 2
        and .last_error_code == null and .leased_by == null)
      and .[0].state.success_activity_count == 2
    ' "$poll_raw" >/dev/null; then
      jq '.[0].state' "$poll_raw" > "$EVIDENCE_DIR/claim-completed.json"
      rm -f "$poll_file" "$poll_raw"
      return
    fi
    sleep 12
  done
  jq '.[0].state' "$poll_raw" > "$EVIDENCE_DIR/claim-timeout.json" 2>/dev/null || true
  rm -f "$poll_file" "$poll_raw"
  die "scheduled Worker did not complete both target jobs within 20 minutes"
}

verify_cloudflare_runtime() {
  local api="https://api.cloudflare.com/client/v4"
  local settings="$RUNNER_TEMP/cloudflare-worker-settings-after.json"
  local subdomain="$RUNNER_TEMP/cloudflare-worker-subdomain-after.json"
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/settings" > "$settings"
  jq -e --arg sha "$APPROVED_SHA" \
    --arg v "$VLADIMIR_BINDING" --arg k "$KRISTINA_BINDING" '
    .success == true
    and any(.result.bindings[]?; .name == "TELEGRAM_DRAIN_ENABLED" and .type == "plain_text" and .text == "true")
    and any(.result.bindings[]?; .name == "VISHAR_ACTIVATION_SHA" and .type == "plain_text" and .text == $sha)
    and any(.result.bindings[]?; .name == "SUPABASE_SECRET_KEY" and (.type == "secret_text" or .type == "secret"))
    and any(.result.bindings[]?; .name == $v and (.type == "secret_text" or .type == "secret"))
    and any(.result.bindings[]?; .name == $k and (.type == "secret_text" or .type == "secret"))
    and ([.result.bindings[]? | select(.type == "secret_text" or .type == "secret") | .name] | sort)
      == (["SUPABASE_SECRET_KEY", $v, $k] | sort)
  ' "$settings" >/dev/null || die "deployed Worker bindings are not the exact staging set"
  jq -n --arg worker "$WORKER_NAME" --arg sha "$APPROVED_SHA" \
    --arg v "$VLADIMIR_BINDING" --arg k "$KRISTINA_BINDING" '
    {worker_name:$worker,activation_sha:$sha,workers_dev:false,routes:[],
     secret_bindings:["SUPABASE_SECRET_KEY",$v,$k],enabled:true}
  ' > "$EVIDENCE_DIR/cloudflare-runtime.json"
  rm -f "$settings"

  curl --fail --silent --show-error \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/$WORKER_NAME/environments/production/subdomain" \
    > "$subdomain"
  jq -e '.success == true and .result.enabled == false' "$subdomain" >/dev/null \
    || die "workers.dev is not disabled for the Telegram drain Worker"
  rm -f "$subdomain"
}

verify_final_state() {
  write_snapshot final
  diff -u \
    <(jq -S '.telegram_rows' "$EVIDENCE_DIR/before.json") \
    <(jq -S --arg v "$VLADIMIR_TARGET_ID" --arg k "$KRISTINA_TARGET_ID" \
      '.telegram_rows | map(select(.id != $v and .id != $k))' "$EVIDENCE_DIR/final.json") >/dev/null \
    || die "automatic drain changed a pre-cutoff Telegram row"
  diff -u <(jq -S '.integrations' "$EVIDENCE_DIR/before.json") \
    <(jq -S '.integrations' "$EVIDENCE_DIR/final.json") >/dev/null \
    || die "automatic drain changed artist routing"
  diff -u <(jq -S '.kristina_booking_source' "$EVIDENCE_DIR/before.json") \
    <(jq -S '.kristina_booking_source' "$EVIDENCE_DIR/final.json") >/dev/null \
    || die "automatic drain changed the Kristina booking source"

  jq -e --arg v "$VLADIMIR_TARGET_ID" --arg k "$KRISTINA_TARGET_ID" '
    . as $root
    | .latest_migration == "0036" and .eligible == 0
    and (.telegram_rows | length) == 19
    and .counts == [
      {artist_id:"a1111111-1111-4111-8111-111111111111",status:"succeeded",count:10},
      {artist_id:"a1111111-1111-4111-8111-111111111111",status:"failed",count:7},
      {artist_id:"a2222222-2222-4222-8222-222222222222",status:"succeeded",count:2}
    ]
    and all(.telegram_rows[] | select(.id == $v or .id == $k);
      .status == "succeeded" and .attempt_count == 2
      and .last_error_code == null
      and .leased_by == null and .leased_at == null and .lease_expires_at == null
      and .created_at >= $root.rollout.automatic_after)
    and (.target_activities | length) == 2
    and all(.target_activities[];
      .event_type == "outbox.succeeded"
      and .metadata.lease_aware == true
      and .metadata.attempt_count == 2
      and .metadata.error_code == null
      and .metadata.dead_letter == false)
    and ([.target_activities[].metadata.worker_id] | unique | length) == 1
  ' "$EVIDENCE_DIR/final.json" >/dev/null || die "final two-artist automatic drain state is invalid"

  npm run scan:secrets | tee "$EVIDENCE_DIR/final-secret-scan.txt"
  jq -n \
    --arg head_sha "$APPROVED_SHA" \
    --arg worker "$WORKER_NAME" \
    --arg cron "$CRON" \
    --arg cutoff "$(jq -r '.rollout.automatic_after' "$EVIDENCE_DIR/final.json")" \
    --argjson plan "$(cat "$EVIDENCE_DIR/cloudflare-plan.json")" \
    --argjson usage "$(cat "$EVIDENCE_DIR/cloudflare-usage.json")" '
    {
      project_ref:"gwaliusblwrzisrwnsvs",head_sha:$head_sha,migration_latest:"0036",
      rollout_cutoff:$cutoff,worker_name:$worker,worker_deployed:true,
      workers_dev:false,routes:[],cron_created:true,cron:$cron,
      synthetic_jobs_created:2,claiming_invocations:1,
      vladimir_provider_accepted:true,kristina_provider_accepted:true,
      both_acknowledged:true,pre_cutoff_rows_unchanged:true,
      historical_seven_unchanged:true,pr189_target_unchanged:true,pr190_target_unchanged:true,
      vladimir_route_unchanged:true,kristina_route_unchanged:true,
      kristina_booking_source_inactive:true,kristina_allowed_origin_null:true,
      secret_bindings:3,global_fallback:false,provider_e2e_executed:true,
      production_targeted:false,secret_scan:"passed",cloudflare_plan:$plan,cloudflare_usage:$usage
    }
  ' > "$EVIDENCE_DIR/summary.json"
}

for name in APPROVED_SHA SUPABASE_ACCESS_TOKEN STAGING_SUPABASE_URL SUPABASE_SECRET_KEY \
  CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID \
  KRISTINA_TELEGRAM_BOT_TOKEN KRISTINA_TELEGRAM_CHAT_ID; do
  require_env "$name"
done
[[ "$APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]] || die "approved SHA is invalid"
[ "$STAGING_SUPABASE_URL" = "$STAGING_ORIGIN" ] || die "unexpected Supabase project URL"
case "$SUPABASE_SECRET_KEY" in sb_secret_*) ;; *) die "unexpected Supabase backend key format" ;; esac
[ "${PRODUCTION_TARGETED:-false}" = false ] || die "production target must remain false"

secrets_file="$RUNNER_TEMP/telegram-drain-secrets.json"
deploy_config="$PWD/wrangler.telegram-drain.activation.toml"
cleanup() {
  rm -f "$secrets_file" "$deploy_config"
  for directory in "$RUNNER_TEMP/telegram-disabled-dry-run" "$RUNNER_TEMP/telegram-enabled-dry-run"; do
    if [ -d "$directory" ]; then
      find "$directory" -depth -delete
    fi
  done
}
trap cleanup EXIT

verify_project_and_pre_state
inspect_cloudflare_cost_and_name
prepare_secrets_and_preflight "$secrets_file"
deploy_disabled_worker "$secrets_file"
create_two_post_cutoff_jobs
deploy_enabled_worker_and_cron "$secrets_file"
wait_for_one_claiming_invocation
verify_cloudflare_runtime
verify_final_state

echo "Telegram automatic drain retained-staging activation succeeded"
