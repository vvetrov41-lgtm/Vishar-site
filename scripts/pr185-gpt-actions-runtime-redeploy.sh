#!/usr/bin/env bash
set -euo pipefail

: "${APPROVED_SHA:?}"
: "${TARGET_ZONE:?}"
: "${TARGET_HOST:?}"
: "${WORKER_NAME:?}"
: "${STAGING_SUPABASE_URL:?}"
: "${STAGING_SUPABASE_PUBLISHABLE_KEY:?}"
: "${CLOUDFLARE_API_TOKEN:?}"
: "${CLOUDFLARE_EDGE_READ_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"

EXPECTED_ZONE='vishartattoo.com'
EXPECTED_HOST='gpt-actions-staging.vishartattoo.com'
EXPECTED_WORKER='vishar-gpt-actions-staging'
EXPECTED_SUPABASE_URL='https://gwaliusblwrzisrwnsvs.supabase.co'
WAF_DESCRIPTION='Vishar GPT Actions staging path boundary'
RATE_DESCRIPTION='staging-booking-rate-limit'
WAF_EXPRESSION='(http.host eq "gpt-actions-staging.vishartattoo.com" and not ((http.request.method eq "GET" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/" or http.request.uri.path eq "/v1/clients/search" or http.request.uri.path eq "/v1/appointments" or starts_with(http.request.uri.path, "/v1/appointments/"))) or (http.request.method eq "HEAD" and (http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/")) or (http.request.method eq "POST" and (http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/" or http.request.uri.path eq "/v1/appointments" or http.request.uri.path eq "/v1/appointments/conflicts" or (starts_with(http.request.uri.path, "/v1/appointments/") and ends_with(http.request.uri.path, "/cancel")))) or (http.request.method eq "PATCH" and starts_with(http.request.uri.path, "/v1/appointments/") and ends_with(http.request.uri.path, "/time"))))'
RATE_EXPRESSION='((http.request.uri.path eq "/__vishar-staging-intake-2026") or (http.host eq "gpt-actions-staging.vishartattoo.com" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/" or starts_with(http.request.uri.path, "/v1/"))))'

[ "$TARGET_ZONE" = "$EXPECTED_ZONE" ]
[ "$TARGET_HOST" = "$EXPECTED_HOST" ]
[ "$WORKER_NAME" = "$EXPECTED_WORKER" ]
[ "$STAGING_SUPABASE_URL" = "$EXPECTED_SUPABASE_URL" ]
case "$STAGING_SUPABASE_PUBLISHABLE_KEY" in
  sb_publishable_*) ;;
  *) echo 'Staging browser key is not publishable.' >&2; exit 1 ;;
esac

grep -Fx 'name = "vishar-gpt-actions-staging"' wrangler.gpt-actions.staging.toml >/dev/null
grep -Fx 'main = "workers/gpt-actions-staging.js"' wrangler.gpt-actions.staging.toml >/dev/null
grep -Fx 'workers_dev = false' wrangler.gpt-actions.staging.toml >/dev/null
grep -Fx 'GPT_ACTIONS_ENABLED = "false"' wrangler.gpt-actions.staging.toml >/dev/null
grep -Fx 'GPT_OAUTH_RELAY_ENABLED = "false"' wrangler.gpt-actions.staging.toml >/dev/null
grep -Fx 'SUPABASE_URL = "https://gwaliusblwrzisrwnsvs.supabase.co"' wrangler.gpt-actions.staging.toml >/dev/null
! grep -Eq 'service_role|SUPABASE_SECRET|SUPABASE_SERVICE|sb_secret_' workers/gpt-actions-staging.js workers/gpt-actions.js workers/lib/gpt-actions.js wrangler.gpt-actions.staging.toml
! grep -Eq '(^|[[:space:]])routes[[:space:]]*=|custom_domain[[:space:]]*=' wrangler.gpt-actions.staging.toml

lookup_auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
edge_auth=(-H "Authorization: Bearer $CLOUDFLARE_EDGE_READ_TOKEN" -H 'Content-Type: application/json')
safe="$RUNNER_TEMP/gpt-actions-runtime-redeploy-evidence.txt"
zone_json="$RUNNER_TEMP/zone.json"
dns_json="$RUNNER_TEMP/dns.json"
routes_json="$RUNNER_TEMP/routes.json"
domains_json="$RUNNER_TEMP/domains.json"
waf_json="$RUNNER_TEMP/waf.json"
rate_json="$RUNNER_TEMP/rate.json"
access_json="$RUNNER_TEMP/access.json"
deployments_json="$RUNNER_TEMP/deployments.json"
pre_version_json="$RUNNER_TEMP/pre-version.json"
post_version_json="$RUNNER_TEMP/post-version.json"

read_edge() {
  curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records?name=$TARGET_HOST&per_page=100" > "$dns_json"
  curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/workers/routes" > "$routes_json"
  curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" > "$domains_json"
  curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$waf_json"
  curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "$rate_json"
  curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" > "$access_json"
}

assert_edge() {
  local phase="$1"
  local dns_target worker_routes target_routes target_domains other_target_domains access_target waf_target waf_exact rate_total rate_exact
  dns_target="$(jq --arg host "$TARGET_HOST" '[.result[]? | select(.name == $host)] | length' "$dns_json")"
  worker_routes="$(jq --arg worker "$WORKER_NAME" '[.result[]? | select((.script // "") == $worker)] | length' "$routes_json")"
  target_routes="$(jq --arg host "$TARGET_HOST" '[.result[]? | select((.pattern // "") | contains($host))] | length' "$routes_json")"
  target_domains="$(jq --arg host "$TARGET_HOST" --arg worker "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service == $worker)] | length' "$domains_json")"
  other_target_domains="$(jq --arg host "$TARGET_HOST" --arg worker "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service != $worker)] | length' "$domains_json")"
  access_target="$(jq --arg host "$TARGET_HOST" '[.result[]? | select((.domain // "") == $host or (.domain // "") == ($host + "/*"))] | length' "$access_json")"
  waf_target="$(jq --arg host "$TARGET_HOST" '[.result.rules[]? | select((.expression // "") | contains($host))] | length' "$waf_json")"
  waf_exact="$(jq --arg description "$WAF_DESCRIPTION" --arg expression "$WAF_EXPRESSION" '[.result.rules[]? | select(.description == $description and .action == "block" and (.enabled // true) == true and .expression == $expression)] | length' "$waf_json")"
  rate_total="$(jq '[.result.rules[]?] | length' "$rate_json")"
  rate_exact="$(jq --arg description "$RATE_DESCRIPTION" --arg expression "$RATE_EXPRESSION" '[.result.rules[]? | select(.description == $description and .action == "block" and (.enabled // true) == true and .expression == $expression and .ratelimit.period == 10 and .ratelimit.requests_per_period == 5 and .ratelimit.mitigation_timeout == 10 and ((.ratelimit.characteristics | sort) == (["cf.colo.id","ip.src"] | sort)))] | length' "$rate_json")"

  [ "$dns_target" = 1 ] || { echo "$phase: target DNS record count is $dns_target." >&2; exit 1; }
  [ "$worker_routes" = 0 ] || { echo "$phase: Worker route bindings are not zero." >&2; exit 1; }
  [ "$target_routes" = 0 ] || { echo "$phase: target host appears in Worker routes." >&2; exit 1; }
  [ "$target_domains" = 1 ] || { echo "$phase: exact target custom domain is not singular." >&2; exit 1; }
  [ "$other_target_domains" = 0 ] || { echo "$phase: target custom domain points to another Worker." >&2; exit 1; }
  [ "$access_target" = 0 ] || { echo "$phase: unexpected Access app exists." >&2; exit 1; }
  [ "$waf_target" = 1 ] && [ "$waf_exact" = 1 ] || { echo "$phase: WAF differs from protected Actions boundary." >&2; exit 1; }
  [ "$rate_total" = 1 ] && [ "$rate_exact" = 1 ] || { echo "$phase: shared 5/10/10 rate limit differs from protected boundary." >&2; exit 1; }

  printf '%s_dns_record_count=%s\n' "$phase" "$dns_target" >> "$safe"
  printf '%s_worker_route_binding_count=%s\n' "$phase" "$worker_routes" >> "$safe"
  printf '%s_target_route_count=%s\n' "$phase" "$target_routes" >> "$safe"
  printf '%s_target_custom_domain_count=%s\n' "$phase" "$target_domains" >> "$safe"
  printf '%s_target_waf_rule_count=%s\n' "$phase" "$waf_target" >> "$safe"
  printf '%s_shared_rate_rule_count=%s\n' "$phase" "$rate_total" >> "$safe"
  printf '%s_target_access_app_count=%s\n' "$phase" "$access_target" >> "$safe"
}

binding_value() {
  local file="$1" name="$2"
  jq -jr --arg name "$name" '[.result.resources.bindings[]? | select(.name == $name)] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$file"
}

binding_type() {
  local file="$1" name="$2"
  jq -jr --arg name "$name" '[.result.resources.bindings[]? | select(.name == $name)] | if length == 1 then (. [0].type // "missing") else "missing" end' "$file"
}

curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/zones?name=$TARGET_ZONE" > "$zone_json"
zone_id="$(jq -r --arg name "$TARGET_ZONE" '[.result[] | select(.name == $name)] | if length == 1 then .[0].id else empty end' "$zone_json")"
[ -n "$zone_id" ] || { echo 'Exact Cloudflare zone not resolved.' >&2; exit 1; }
plan_legacy_id="$(jq -r --arg name "$TARGET_ZONE" '[.result[] | select(.name == $name)] | .[0].plan.legacy_id // "unknown"' "$zone_json")"
[ "$plan_legacy_id" = free ] || { echo "Unexpected Cloudflare plan '$plan_legacy_id'." >&2; exit 1; }

cat > "$safe" <<EOF
exact_sha=$APPROVED_SHA
target_zone=$TARGET_ZONE
target_host=$TARGET_HOST
worker=$WORKER_NAME
zone_plan_legacy_id=$plan_legacy_id
rollback_attempted=false
worker_updated=false
waf_mutated=false
rate_limit_mutated=false
production_targeted=false
EOF

read_edge
assert_edge pre

curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/deployments" > "$deployments_json"
pre_active_version_id="$(jq -r '.result.deployments[0].versions | map(select(.percentage == 100)) | if length == 1 then .[0].version_id else empty end' "$deployments_json")"
[ -n "$pre_active_version_id" ] || { echo 'Unable to resolve one active Worker version.' >&2; exit 1; }
curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/versions/$pre_active_version_id" > "$pre_version_json"
pre_actions="$(binding_value "$pre_version_json" GPT_ACTIONS_ENABLED)"
pre_relay="$(binding_value "$pre_version_json" GPT_OAUTH_RELAY_ENABLED)"
pre_url="$(binding_value "$pre_version_json" SUPABASE_URL)"
pre_key_type="$(binding_type "$pre_version_json" SUPABASE_PUBLISHABLE_KEY)"
[ "$pre_actions" = true ] || { echo 'Pre-active Worker Actions are not enabled.' >&2; exit 1; }
[ "$pre_relay" = true ] || { echo 'Pre-active OAuth relay is not enabled.' >&2; exit 1; }
[ "$pre_url" = "$EXPECTED_SUPABASE_URL" ] || { echo 'Pre-active Worker points outside retained staging.' >&2; exit 1; }
[ "$pre_key_type" = plain_text ] || { echo 'Unexpected publishable-key binding type.' >&2; exit 1; }
printf 'pre_active_version_id=%s\npre_GPT_ACTIONS_ENABLED=%s\npre_GPT_OAUTH_RELAY_ENABLED=%s\n' "$pre_active_version_id" "$pre_actions" "$pre_relay" >> "$safe"

complete=false
worker_changed=false
rollback() {
  original_status=$?
  if [ "$complete" = true ]; then return "$original_status"; fi
  set +e
  sed -i 's/^rollback_attempted=.*/rollback_attempted=true/' "$safe"
  if [ "$worker_changed" = true ]; then
    rollback_status=0
    npx wrangler rollback "$pre_active_version_id" --name "$WORKER_NAME" --message "PR185 GPT Actions staging runtime rollback" > "$RUNNER_TEMP/worker-rollback.log" 2>&1 || rollback_status=$?
    printf 'rollback_worker_version_id=%s\nrollback_worker_status=%s\n' "$pre_active_version_id" "$rollback_status" >> "$safe"
  fi
  set -e
  return "$original_status"
}
trap rollback EXIT

npx wrangler deploy --config wrangler.gpt-actions.staging.toml --dry-run --outdir "$RUNNER_TEMP/gpt-actions-runtime-dry-run" \
  --var SUPABASE_URL:"$STAGING_SUPABASE_URL" \
  --var SUPABASE_PUBLISHABLE_KEY:"$STAGING_SUPABASE_PUBLISHABLE_KEY" \
  --var GPT_ACTIONS_ENABLED:true \
  --var GPT_OAUTH_RELAY_ENABLED:true >/dev/null

npx wrangler deploy --config wrangler.gpt-actions.staging.toml \
  --var SUPABASE_URL:"$STAGING_SUPABASE_URL" \
  --var SUPABASE_PUBLISHABLE_KEY:"$STAGING_SUPABASE_PUBLISHABLE_KEY" \
  --var GPT_ACTIONS_ENABLED:true \
  --var GPT_OAUTH_RELAY_ENABLED:true | tee "$RUNNER_TEMP/worker-deploy.log"
worker_changed=true
sed -i 's/^worker_updated=.*/worker_updated=true/' "$safe"

post_active_version_id=''
for attempt in $(seq 1 24); do
  curl --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/deployments" > "$deployments_json" || true
  post_active_version_id="$(jq -r '.result.deployments[0].versions | map(select(.percentage == 100)) | if length == 1 then .[0].version_id else empty end' "$deployments_json")"
  if [ -n "$post_active_version_id" ] && [ "$post_active_version_id" != "$pre_active_version_id" ]; then break; fi
  sleep 5
done
[ -n "$post_active_version_id" ] && [ "$post_active_version_id" != "$pre_active_version_id" ] || { echo 'New active Worker version was not observed.' >&2; exit 1; }
curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/versions/$post_active_version_id" > "$post_version_json"
post_actions="$(binding_value "$post_version_json" GPT_ACTIONS_ENABLED)"
post_relay="$(binding_value "$post_version_json" GPT_OAUTH_RELAY_ENABLED)"
post_url="$(binding_value "$post_version_json" SUPABASE_URL)"
[ "$post_actions" = true ]
[ "$post_relay" = true ]
[ "$post_url" = "$EXPECTED_SUPABASE_URL" ]
printf 'post_active_version_id=%s\npost_GPT_ACTIONS_ENABLED=%s\npost_GPT_OAUTH_RELAY_ENABLED=%s\n' "$post_active_version_id" "$post_actions" "$post_relay" >> "$safe"

request_status() {
  local method="$1" url="$2"
  shift 2
  curl --silent --show-error --max-time 20 -X "$method" -o /dev/null -w '%{http_code}' "$@" "$url" || true
}

wait_for_status() {
  local expected="$1" method="$2" url="$3"
  shift 3
  local status='000'
  for attempt in $(seq 1 18); do
    status="$(request_status "$method" "$url" "$@")"
    [ "$status" = "$expected" ] && { printf '%s' "$status"; return 0; }
    sleep 5
  done
  printf '%s' "$status"
  return 1
}

base="https://$TARGET_HOST"
privacy_status="$(wait_for_status 200 GET "$base/privacy")"
printf 'privacy_status=%s\n' "$privacy_status" >> "$safe"
sleep 11
malformed_bearer_status="$(wait_for_status 401 GET "$base/v1/appointments?from=2026-08-10T00%3A00%3A00Z&to=2026-08-11T00%3A00%3A00Z" -H 'Authorization: Bearer deliberately-invalid-token')"
printf 'malformed_bearer_status=%s\n' "$malformed_bearer_status" >> "$safe"
sleep 11
unauthenticated_status="$(wait_for_status 401 GET "$base/v1/appointments?from=2026-08-10T00%3A00%3A00Z&to=2026-08-11T00%3A00%3A00Z")"
printf 'unauthenticated_action_status=%s\n' "$unauthenticated_status" >> "$safe"
sleep 11
token_guard_status="$(wait_for_status 415 POST "$base/oauth/token" -H 'Content-Type: application/json' --data '{}')"
printf 'oauth_token_content_type_guard_status=%s\n' "$token_guard_status" >> "$safe"
sleep 11
disallowed_path_status="$(wait_for_status 403 GET "$base/not-an-approved-route")"
printf 'disallowed_path_waf_status=%s\n' "$disallowed_path_status" >> "$safe"

read_edge
assert_edge post
printf 'cloudflare_mutated=true\n' >> "$safe"
complete=true
trap - EXIT
cat "$safe"
