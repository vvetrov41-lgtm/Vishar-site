#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/pr186-kristina-intake-staging-v4-lib.sh"

# Prepare a temporary preview-only Wrangler config. Production entrypoint stays untouched.
cp wrangler.toml "$CONFIG"
python3 - <<'PY'
from pathlib import Path
import os
p = Path(os.environ['CONFIG'])
text = p.read_text(encoding='utf-8')
old = 'main = "workers/tattooai.js"'
new = 'main = "workers/preview.js"'
if text.count(old) != 1:
    raise SystemExit('expected exactly one production Worker entrypoint')
p.write_text(text.replace(old, new), encoding='utf-8')
PY

grep -Fx 'workers_dev = false' "$CONFIG" >/dev/null
! grep -Eq '^(route|routes)[[:space:]]*=' "$CONFIG"

npx wrangler secret list --config "$CONFIG" --env preview --format json > "$RUNNER_TEMP/intake-secrets-before.json"
jq -e '[.[].name] | index("SUPABASE_SECRET_KEY") != null' "$RUNNER_TEMP/intake-secrets-before.json" >/dev/null
jq -e '[.[].name] | index("ARTIST_TELEGRAM_VLADIMIR_HSTAGING") != null' "$RUNNER_TEMP/intake-secrets-before.json" >/dev/null
jq -e '[.[].name] | index("TELEGRAM_BOT_TOKEN") == null and index("TELEGRAM_CHAT_ID") == null' "$RUNNER_TEMP/intake-secrets-before.json" >/dev/null

# Retained DB must be exactly at the expected pre-transition state.
cat > "$RUNNER_TEMP/preflight.sql" <<SQL
select jsonb_build_object(
  'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
  'vladimir_source', (
    select jsonb_build_object('artist_id', artist_id, 'allowed_origin', allowed_origin, 'form_version', form_version, 'is_active', is_active)
    from public.booking_sources where source_key='vladimir-staging'
  ),
  'kristina_source', (
    select jsonb_build_object('artist_id', artist_id, 'allowed_origin', allowed_origin, 'form_version', form_version, 'is_active', is_active)
    from public.booking_sources where source_key='kristina-website'
  ),
  'kristina_telegram_enabled', (
    select count(*) from public.artist_integrations
    where artist_id='$KRISTINA_ID' and integration_type='telegram' and is_enabled
  )
) as state;
SQL
sql_query "$RUNNER_TEMP/preflight.sql" "$RUNNER_TEMP/preflight-rows.json"
jq -e --arg vladimir "$VLADIMIR_ID" --arg vorig "$VLADIMIR_ORIGIN" --arg kristina "$KRISTINA_ID" '
  length == 1
  and .[0].state.latest_migration == "0034"
  and .[0].state.vladimir_source.artist_id == $vladimir
  and .[0].state.vladimir_source.allowed_origin == $vorig
  and .[0].state.vladimir_source.form_version == "booking-v1"
  and .[0].state.vladimir_source.is_active == true
  and .[0].state.kristina_source.artist_id == $kristina
  and .[0].state.kristina_source.allowed_origin == null
  and .[0].state.kristina_source.form_version == "booking-v1"
  and .[0].state.kristina_source.is_active == false
  and .[0].state.kristina_telegram_enabled == 0
' "$RUNNER_TEMP/preflight-rows.json" >/dev/null

previous_version="$(active_worker_version "$RUNNER_TEMP/deployments-before.json")"
[[ "$previous_version" =~ ^[0-9a-f-]{36}$ ]] || {
  echo 'Could not resolve current retained Worker version.' >&2
  exit 1
}
echo "Retained Worker version before deploy: $previous_version"

# Read all relevant control-plane state without requiring stale Access app names, then prove edge behavior live.
read_control_plane before
live_edge_check before false

# Activate only the exact Kristina staging booking source.
cat > "$RUNNER_TEMP/activate.sql" <<SQL
update public.booking_sources
set allowed_origin='$KRISTINA_ORIGIN', form_version='booking-v1', is_active=true
where source_key='kristina-website' and artist_id='$KRISTINA_ID'
returning source_key, artist_id, allowed_origin, form_version, is_active;
SQL
sql_query "$RUNNER_TEMP/activate.sql" "$RUNNER_TEMP/activate-rows.json"
jq -e --arg kristina "$KRISTINA_ID" --arg origin "$KRISTINA_ORIGIN" '
  length == 1
  and .[0].source_key == "kristina-website"
  and .[0].artist_id == $kristina
  and .[0].allowed_origin == $origin
  and .[0].form_version == "booking-v1"
  and .[0].is_active == true
' "$RUNNER_TEMP/activate-rows.json" >/dev/null
metadata_changed=true

# `--keep-vars` preserves all existing retained-staging plaintext variables while the three named vars are updated.
npx wrangler deploy \
  --config "$CONFIG" \
  --env preview \
  --dry-run \
  --outdir "$RUNNER_TEMP/intake-dry-run" \
  --keep-vars \
  --var VISHAR_ENVIRONMENT:preview \
  --var SUPABASE_URL:"$STAGING_SUPABASE_URL" \
  --var ALLOWED_ORIGINS:"$VLADIMIR_ORIGIN,$KRISTINA_ORIGIN" >/dev/null

current_predeploy_version="$(active_worker_version "$RUNNER_TEMP/deployments-predeploy.json")"
[ "$current_predeploy_version" = "$previous_version" ] || {
  echo 'Retained Worker changed after preflight; refusing to deploy over a moving target.' >&2
  exit 1
}

export WRANGLER_OUTPUT_FILE_PATH="$RUNNER_TEMP/wrangler-output.ndjson"
npx wrangler deploy \
  --config "$CONFIG" \
  --env preview \
  --keep-vars \
  --var VISHAR_ENVIRONMENT:preview \
  --var SUPABASE_URL:"$STAGING_SUPABASE_URL" \
  --var ALLOWED_ORIGINS:"$VLADIMIR_ORIGIN,$KRISTINA_ORIGIN" \
  > "$RUNNER_TEMP/intake-deploy.log" 2>&1
worker_maybe_changed=true

new_version="$(jq -r 'select(.type == "deploy") | .version_id // empty' "$WRANGLER_OUTPUT_FILE_PATH" 2>/dev/null | tail -n1)"
if ! [[ "$new_version" =~ ^[0-9a-f-]{36}$ ]]; then
  new_version="$(active_worker_version "$RUNNER_TEMP/deployments-after.json")"
fi
[[ "$new_version" =~ ^[0-9a-f-]{36}$ ]] || {
  echo 'Could not resolve deployed retained Worker version.' >&2
  exit 1
}
[ "$new_version" != "$previous_version" ] || {
  echo 'Retained Worker active version did not change after deploy.' >&2
  exit 1
}
echo "Retained Worker deployed version: $new_version"

npx wrangler secret list --config "$CONFIG" --env preview --format json > "$RUNNER_TEMP/intake-secrets-after.json"
jq -e '[.[].name] | index("SUPABASE_SECRET_KEY") != null' "$RUNNER_TEMP/intake-secrets-after.json" >/dev/null
jq -e '[.[].name] | index("ARTIST_TELEGRAM_VLADIMIR_HSTAGING") != null' "$RUNNER_TEMP/intake-secrets-after.json" >/dev/null
jq -e '[.[].name] | index("TELEGRAM_BOT_TOKEN") == null and index("TELEGRAM_CHAT_ID") == null' "$RUNNER_TEMP/intake-secrets-after.json" >/dev/null

# Cloudflare Access/WAF/rate-limit configs must be byte-equivalent after canonicalization; workers.dev remains disabled.
read_control_plane after
live_edge_check after true

# Synthetic Kristina intake with hostile browser-routing fields and one tiny PNG reference.
wrong_key="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
wrong_code="$(curl --silent --show-error --output "$EVIDENCE_DIR/wrong-origin.json" --write-out '%{http_code}' \
  -X POST -H 'Origin: https://evil.example' \
  -F "idempotencyKey=$wrong_key" -F 'name=PR186 Synthetic Wrong Origin' \
  -F 'email=pr186-wrong@example.invalid' -F 'preferredReply=Email' \
  -F 'projectType=Black and grey realism' -F 'placement=Forearm' -F 'size=15 cm' \
  -F 'coverUp=No' -F 'idea=Synthetic wrong-origin rejection check.' \
  -F 'privacyAcknowledged=true' -F 'privacyNoticeVersion=2026-07-29' \
  "$WORKER_URL")"
[ "$wrong_code" = 403 ] || {
  echo "Wrong Origin POST was not rejected, HTTP $wrong_code." >&2
  exit 1
}

python3 - <<'PY'
from pathlib import Path
import os
Path(os.environ['RUNNER_TEMP'], 'synthetic-reference.png').write_bytes(
    bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082')
)
PY

intake_key="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
curl --fail-with-body --silent --show-error \
  -H "Origin: $KRISTINA_ORIGIN" \
  -F "idempotencyKey=$intake_key" \
  -F "name=PR186 Synthetic Kristina ${GITHUB_RUN_ID}" \
  -F "email=pr186-${GITHUB_RUN_ID}@example.invalid" \
  -F 'phone=' -F 'instagram=' -F 'preferredReply=Email' -F 'travellingFrom=London' \
  -F 'projectType=Black and grey realism' -F 'placement=Outer forearm' -F 'size=18 cm' \
  -F 'coverUp=No' -F 'timing=Flexible' \
  -F 'idea=Synthetic Kristina retained staging intake routing validation.' \
  -F 'website=' -F 'source=kristinavishar.com/#booking' -F "landingPage=$KRISTINA_ORIGIN/#booking" \
  -F 'referrer=' -F 'utmSource=pr186-staging' -F 'utmMedium=synthetic' \
  -F 'privacyAcknowledged=true' -F 'privacyNoticeVersion=2026-07-29' \
  -F "artist_id=$VLADIMIR_ID" \
  -F 'integration_key=vladimir-staging' \
  -F 'provider_account=forbidden-browser-route' \
  -F 'payment_destination=forbidden-browser-route' \
  -F "references=@${RUNNER_TEMP}/synthetic-reference.png;type=image/png" \
  "$WORKER_URL" > "$EVIDENCE_DIR/kristina-response.json"
jq -e '.ok == true and (.reference | type == "string")' "$EVIDENCE_DIR/kristina-response.json" >/dev/null
reference="$(jq -r '.reference' "$EVIDENCE_DIR/kristina-response.json")"

cat > "$RUNNER_TEMP/e2e.sql" <<SQL
select jsonb_build_object(
  'wrong_origin_rows', (select count(*) from public.enquiries where idempotency_key='$wrong_key'::uuid),
  'reference', e.reference_number,
  'artist_id', e.artist_id,
  'source_key', s.source_key,
  'intake_state', e.intake_state,
  'ready_files', (select count(*) from public.enquiry_files f where f.enquiry_id=e.id and f.upload_state='ready'),
  'storage_objects', (
    select count(*) from storage.objects o
    where o.bucket_id='crm-files'
      and o.name in (select f.storage_path from public.enquiry_files f where f.enquiry_id=e.id)
  ),
  'outbox_rows', (select count(*) from public.integration_outbox o where o.enquiry_id=e.id and o.artist_id='$KRISTINA_ID'),
  'provider_route_unavailable', (
    select count(*) from public.integration_outbox o
    where o.enquiry_id=e.id and o.artist_id='$KRISTINA_ID'
      and o.status='failed' and o.last_error_code='provider_route_unavailable'
  ),
  'kristina_telegram_enabled', (
    select count(*) from public.artist_integrations i
    where i.artist_id='$KRISTINA_ID' and i.integration_type='telegram' and i.is_enabled
  )
) as evidence
from public.enquiries e
join public.booking_sources s on s.id=e.booking_source_id
where e.reference_number='$reference';
SQL
sql_query "$RUNNER_TEMP/e2e.sql" "$RUNNER_TEMP/e2e-rows.json"
jq -e --arg reference "$reference" --arg kristina "$KRISTINA_ID" '
  length == 1
  and .[0].evidence.wrong_origin_rows == 0
  and .[0].evidence.reference == $reference
  and .[0].evidence.artist_id == $kristina
  and .[0].evidence.source_key == "kristina-website"
  and .[0].evidence.intake_state == "complete"
  and .[0].evidence.ready_files == 1
  and .[0].evidence.storage_objects == 1
  and .[0].evidence.outbox_rows >= 1
  and .[0].evidence.provider_route_unavailable >= 1
  and .[0].evidence.kristina_telegram_enabled == 0
' "$RUNNER_TEMP/e2e-rows.json" >/dev/null

# Final source state must retain Vladimir and activate only the exact Kristina source.
cat > "$RUNNER_TEMP/final.sql" <<SQL
select source_key, artist_id, allowed_origin, form_version, is_active
from public.booking_sources
where source_key in ('vladimir-staging','kristina-website')
order by source_key;
SQL
sql_query "$RUNNER_TEMP/final.sql" "$RUNNER_TEMP/final-rows.json"
jq -e --arg vladimir "$VLADIMIR_ID" --arg vorig "$VLADIMIR_ORIGIN" --arg kristina "$KRISTINA_ID" --arg korig "$KRISTINA_ORIGIN" '
  length == 2
  and any(.[]; .source_key == "vladimir-staging" and .artist_id == $vladimir and .allowed_origin == $vorig and .form_version == "booking-v1" and .is_active == true)
  and any(.[]; .source_key == "kristina-website" and .artist_id == $kristina and .allowed_origin == $korig and .form_version == "booking-v1" and .is_active == true)
' "$RUNNER_TEMP/final-rows.json" >/dev/null

jq -n \
  --arg exact_head "$APPROVED_SHA" \
  --argjson run_id "$GITHUB_RUN_ID" \
  --arg previous_worker_version "$previous_version" \
  --arg worker_version "$new_version" \
  --arg reference "$reference" \
  '{exact_head:$exact_head, run_id:$run_id, previous_worker_version:$previous_worker_version, worker_version:$worker_version, kristina_reference:$reference, artist_id:"a2222222-2222-4222-8222-222222222222", source_key:"kristina-website", intake_state:"complete", ready_files:1, storage_objects:1, wrong_origin_rows:0, browser_routing_fields_ignored:true, crm_side_telegram_enabled:false, access_unchanged:true, waf_unchanged:true, rate_limit_unchanged:true, workers_dev:false, production_targeted:false}' \
  > "$EVIDENCE_DIR/summary.json"

metadata_changed=false
worker_maybe_changed=false
trap - EXIT
