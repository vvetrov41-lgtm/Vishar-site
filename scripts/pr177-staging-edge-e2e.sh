#!/usr/bin/env bash
set -euo pipefail

readonly WORKER_NAME="tattooai-preview"
readonly WORKER_URL="https://intake-staging.vishartattoo.com/__vishar-staging-intake-2026"
readonly WORKER_HOST="intake-staging.vishartattoo.com"
readonly WORKER_PATH="/__vishar-staging-intake-2026"
readonly BOOKING_ORIGIN="https://vishar-booking-staging.pages.dev"
readonly BOOKING_DOMAIN="vishar-booking-staging.pages.dev"
readonly CRM_ORIGIN="https://vishar-crm-staging.pages.dev"
readonly CRM_DOMAIN="vishar-crm-staging.pages.dev"
readonly evidence_dir="${RUNNER_TEMP:?}/pr177-staging-evidence"
mkdir -p "$evidence_dir"

die() { echo "staging edge E2E failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

require_env CLOUDFLARE_API_TOKEN
require_env CLOUDFLARE_ACCOUNT_ID

api='https://api.cloudflare.com/client/v4'
auth_headers=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')

[ "$WORKER_URL" = "https://${WORKER_HOST}${WORKER_PATH}" ] || die "Worker target mismatch"
[[ "$BOOKING_DOMAIN" == *-staging.pages.dev ]] || die "booking target is not staging"
[[ "$CRM_DOMAIN" == *-staging.pages.dev ]] || die "CRM target is not staging"

code="$(curl --silent --show-error -D "${evidence_dir}/booking-access.headers" -o /dev/null -w '%{http_code}' "$BOOKING_ORIGIN/booking/")"
case "$code" in 301|302|303|307|308) ;; *) die "Booking Pages was not Access-gated: HTTP $code";; esac
grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/booking-access.headers" \
  || die "Booking Pages did not redirect to Cloudflare Access"

code="$(curl --silent --show-error -D "${evidence_dir}/crm-access.headers" -o /dev/null -w '%{http_code}' "$CRM_ORIGIN/")"
case "$code" in 301|302|303|307|308) ;; *) die "CRM Pages was not Access-gated: HTTP $code";; esac
grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/crm-access.headers" \
  || die "CRM Pages did not redirect to Cloudflare Access"

code="$(curl --silent --show-error -D "${evidence_dir}/trusted-preflight.headers" -o /dev/null -w '%{http_code}' \
  -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
[ "$code" = 204 ] || die "trusted CORS preflight was HTTP $code"
grep -Fqi "access-control-allow-origin: $BOOKING_ORIGIN" "${evidence_dir}/trusted-preflight.headers" \
  || die "trusted preflight lacked the exact staging allow-origin"
! grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/trusted-preflight.headers" \
  || die "Cloudflare Access is incorrectly in front of the intake Worker"

code="$(curl --silent --show-error -D "${evidence_dir}/invalid-preflight.headers" \
  -o "${evidence_dir}/invalid-origin.json" -w '%{http_code}' \
  -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
[ "$code" = 403 ] || die "wrong Origin was not rejected: HTTP $code"
! grep -Eqi '^access-control-allow-origin:' "${evidence_dir}/invalid-preflight.headers" \
  || die "wrong Origin received an allow-origin header"

code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X GET "$WORKER_URL")"
[ "$code" = 403 ] || die "WAF did not block GET on the intake path: HTTP $code"
code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' \
  "https://${WORKER_HOST}/__pr177-wrong-path")"
[ "$code" = 403 ] || die "WAF did not block OPTIONS on a wrong path: HTTP $code"
code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X POST \
  -H "Origin: $BOOKING_ORIGIN" "https://${WORKER_HOST}/__pr177-wrong-path")"
[ "$code" = 403 ] || die "WAF did not block POST on a wrong path: HTTP $code"

curl --silent --show-error "${auth_headers[@]}" "$api/zones?name=vishartattoo.com" \
  > "${evidence_dir}/zones.json"
jq -e '.success == true' "${evidence_dir}/zones.json" >/dev/null \
  || die "Cloudflare zone query failed"
zone_id="$(jq -r '.result[0].id // empty' "${evidence_dir}/zones.json")"
[ -n "$zone_id" ] || die "staging Cloudflare zone was unavailable"

# Cloudflare supports both account- and zone-scoped Access application paths.
# Try the account path first, then the zone path. Do not weaken the assertion if
# the token lacks Access: Apps and Policies Read at both scopes.
access_scope_kind='accounts'
access_scope_id="$CLOUDFLARE_ACCOUNT_ID"
curl --silent --show-error "${auth_headers[@]}" \
  "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps?per_page=100" \
  > "${evidence_dir}/access-apps-account.json"
if jq -e '.success == true' "${evidence_dir}/access-apps-account.json" >/dev/null; then
  cp "${evidence_dir}/access-apps-account.json" "${evidence_dir}/access-apps.json"
else
  access_scope_kind='zones'
  access_scope_id="$zone_id"
  curl --silent --show-error "${auth_headers[@]}" \
    "$api/zones/$zone_id/access/apps?per_page=100" \
    > "${evidence_dir}/access-apps-zone.json"
  jq -e '.success == true' "${evidence_dir}/access-apps-zone.json" >/dev/null \
    || die "Cloudflare token lacks Access application read access at account and zone scope"
  cp "${evidence_dir}/access-apps-zone.json" "${evidence_dir}/access-apps.json"
fi

jq -e --arg booking "$BOOKING_DOMAIN" --arg crm "$CRM_DOMAIN" '
  [.result[] | select(.domain == $booking or .domain == $crm)] | length == 2
' "${evidence_dir}/access-apps.json" >/dev/null \
  || die "both staging Pages Access apps were not found"
jq -e --arg worker "$WORKER_HOST" '
  [.result[] | select(.domain == $worker or ((.domain // "") | startswith($worker + "/")))] | length == 0
' "${evidence_dir}/access-apps.json" >/dev/null \
  || die "an Access app is incorrectly attached to the intake Worker"

booking_app_id="$(jq -r --arg domain "$BOOKING_DOMAIN" '.result[] | select(.domain==$domain) | .id' "${evidence_dir}/access-apps.json" | head -n1)"
crm_app_id="$(jq -r --arg domain "$CRM_DOMAIN" '.result[] | select(.domain==$domain) | .id' "${evidence_dir}/access-apps.json" | head -n1)"
[ -n "$booking_app_id" ] && [ -n "$crm_app_id" ] || die "staging Access app ids were absent"

booking_policy_file="${RUNNER_TEMP}/pr177-booking-access-policies.json"
crm_policy_file="${RUNNER_TEMP}/pr177-crm-access-policies.json"
curl --silent --show-error "${auth_headers[@]}" \
  "$api/$access_scope_kind/$access_scope_id/access/apps/$booking_app_id/policies" > "$booking_policy_file"
curl --silent --show-error "${auth_headers[@]}" \
  "$api/$access_scope_kind/$access_scope_id/access/apps/$crm_app_id/policies" > "$crm_policy_file"

for policy_file in "$booking_policy_file" "$crm_policy_file"; do
  jq -e '
    .success == true
    and ([.result[] | select(.decision == "allow")] | length == 1)
    and ([.result[] | select(.decision == "bypass" or .decision == "service_auth")] | length == 0)
    and ([.result[] | select(.decision == "allow") | .include[]?] as $include
         | ($include | length) == 1
         and all($include[]; has("email")))
  ' "$policy_file" >/dev/null || die "a staging Pages Access policy was not owner-only"
done
rm -f "$booking_policy_file" "$crm_policy_file"

curl --silent --show-error "${auth_headers[@]}" \
  "$api/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" \
  > "${evidence_dir}/waf.json"
curl --silent --show-error "${auth_headers[@]}" \
  "$api/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" \
  > "${evidence_dir}/rate-limit.json"
curl --silent --show-error "${auth_headers[@]}" \
  "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/$WORKER_NAME/environments/production/subdomain" \
  > "${evidence_dir}/subdomain.json"

jq -e --arg host "$WORKER_HOST" --arg path "$WORKER_PATH" '
  .success == true and
  ([.result.rules[]? | select(
    .enabled
    and ((.expression // "") | contains($host))
    and ((.expression // "") | contains($path))
    and ((.expression // "") | contains("POST"))
    and ((.expression // "") | contains("OPTIONS"))
  )] | length > 0)
' "${evidence_dir}/waf.json" >/dev/null || die "exact staging WAF path/method rule was not found"
jq -e --arg host "$WORKER_HOST" --arg path "$WORKER_PATH" '
  .success == true and
  ([.result.rules[]? | select(
    .enabled
    and ((.expression // "") | contains($host))
    and ((.expression // "") | contains($path))
  )] | length > 0)
' "${evidence_dir}/rate-limit.json" >/dev/null || die "staging rate-limit rule was not found"
jq -e '.success == true and .result.enabled == false and .result.previews_enabled == false' \
  "${evidence_dir}/subdomain.json" >/dev/null || die "workers.dev or Worker previews are enabled"

limited=false
for _ in 1 2 3 4 5 6 7; do
  code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
    -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 429 ] && limited=true
done
$limited || die "rate-limit probe did not observe HTTP 429"
sleep 12
code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
[ "$code" = 204 ] || die "rate limit did not recover to HTTP 204"

jq -n \
  --arg booking "$BOOKING_DOMAIN" \
  --arg crm "$CRM_DOMAIN" \
  --arg worker "$WORKER_HOST" \
  --arg access_scope "$access_scope_kind" \
  '{
    booking_access:{domain:$booking,owner_only:true},
    crm_access:{domain:$crm,owner_only:true},
    access_api_scope:$access_scope,
    intake_worker:{domain:$worker,access:false,workers_dev:false},
    cors:{exact_staging_origin:true,wrong_origin_rejected:true},
    waf:{exact_path_and_methods:true,wrong_path_blocked:true,wrong_method_blocked:true},
    rate_limit:{observed_429:true,recovered:true},
    production_targeting:false
  }' > "${evidence_dir}/edge-evidence.json"
