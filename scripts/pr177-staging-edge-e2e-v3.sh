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
blockers='[]'
add_blocker() { blockers="$(jq -c --arg item "$1" '. + [$item] | unique' <<<"$blockers")"; }

[ "$WORKER_URL" = "https://${WORKER_HOST}${WORKER_PATH}" ] || die "Worker target mismatch"
[[ "$BOOKING_DOMAIN" == *-staging.pages.dev ]] || die "booking target is not staging"
[[ "$CRM_DOMAIN" == *-staging.pages.dev ]] || die "CRM target is not staging"

# Public Access gate evidence for both staging Pages applications.
code="$(curl --silent --show-error -D "$evidence_dir/booking-access.headers" -o /dev/null -w '%{http_code}' "$BOOKING_ORIGIN/booking/")"
case "$code" in 301|302|303|307|308) ;; *) die "Booking Pages was not Access-gated: HTTP $code";; esac
grep -Eqi '^location: .*cloudflareaccess' "$evidence_dir/booking-access.headers" \
  || die "Booking Pages did not redirect to Cloudflare Access"

code="$(curl --silent --show-error -D "$evidence_dir/crm-access.headers" -o /dev/null -w '%{http_code}' "$CRM_ORIGIN/")"
case "$code" in 301|302|303|307|308) ;; *) die "CRM Pages was not Access-gated: HTTP $code";; esac
grep -Eqi '^location: .*cloudflareaccess' "$evidence_dir/crm-access.headers" \
  || die "CRM Pages did not redirect to Cloudflare Access"

# Exact trusted Origin reaches the Worker. Wrong Origin fails closed. The lack
# of an Access redirect here independently shows Access is not in front of the
# browser intake endpoint.
code="$(curl --silent --show-error -D "$evidence_dir/trusted-preflight.headers" -o /dev/null -w '%{http_code}' \
  -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
[ "$code" = 204 ] || die "trusted CORS preflight was HTTP $code"
grep -Fqi "access-control-allow-origin: $BOOKING_ORIGIN" "$evidence_dir/trusted-preflight.headers" \
  || die "trusted preflight lacked the exact staging allow-origin"
! grep -Eqi '^location: .*cloudflareaccess' "$evidence_dir/trusted-preflight.headers" \
  || die "Cloudflare Access is incorrectly in front of the intake Worker"

code="$(curl --silent --show-error -D "$evidence_dir/invalid-preflight.headers" \
  -o "$evidence_dir/invalid-origin.json" -w '%{http_code}' \
  -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
[ "$code" = 403 ] || die "wrong Origin was not rejected: HTTP $code"
! grep -Eqi '^access-control-allow-origin:' "$evidence_dir/invalid-preflight.headers" \
  || die "wrong Origin received an allow-origin header"

# Runtime WAF proof: only POST/OPTIONS on the exact path can reach the Worker.
code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X GET "$WORKER_URL")"
[ "$code" = 403 ] || die "WAF did not block GET on the intake path: HTTP $code"
code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' \
  "https://${WORKER_HOST}/__pr177-wrong-path")"
[ "$code" = 403 ] || die "WAF did not block OPTIONS on a wrong path: HTTP $code"
code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X POST \
  -H "Origin: $BOOKING_ORIGIN" "https://${WORKER_HOST}/__pr177-wrong-path")"
[ "$code" = 403 ] || die "WAF did not block POST on a wrong path: HTTP $code"

curl --silent --show-error "${auth_headers[@]}" "$api/zones?name=vishartattoo.com" > "$evidence_dir/zones.json"
jq -e '.success == true' "$evidence_dir/zones.json" >/dev/null || die "Cloudflare zone query failed"
zone_id="$(jq -r '.result[0].id // empty' "$evidence_dir/zones.json")"
[ -n "$zone_id" ] || die "staging Cloudflare zone was unavailable"

# Access policy contents need the separate Access: Apps and Policies Read
# permission. Try both supported scopes and preserve an explicit blocker if the
# deployment token cannot independently read the policies.
access_verified=false
access_scope_kind=''
access_scope_id=''
curl --silent --show-error "${auth_headers[@]}" \
  "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps?per_page=100" > "$evidence_dir/access-apps-account.json"
if jq -e '.success == true' "$evidence_dir/access-apps-account.json" >/dev/null; then
  access_verified=true; access_scope_kind='accounts'; access_scope_id="$CLOUDFLARE_ACCOUNT_ID"
  cp "$evidence_dir/access-apps-account.json" "$evidence_dir/access-apps.json"
else
  curl --silent --show-error "${auth_headers[@]}" \
    "$api/zones/$zone_id/access/apps?per_page=100" > "$evidence_dir/access-apps-zone.json"
  if jq -e '.success == true' "$evidence_dir/access-apps-zone.json" >/dev/null; then
    access_verified=true; access_scope_kind='zones'; access_scope_id="$zone_id"
    cp "$evidence_dir/access-apps-zone.json" "$evidence_dir/access-apps.json"
  fi
fi

if $access_verified; then
  jq -e --arg booking "$BOOKING_DOMAIN" --arg crm "$CRM_DOMAIN" '
    [.result[] | select(.domain == $booking or .domain == $crm)] | length == 2
  ' "$evidence_dir/access-apps.json" >/dev/null || die "both staging Pages Access apps were not found"
  jq -e --arg worker "$WORKER_HOST" '
    [.result[] | select(.domain == $worker or ((.domain // "") | startswith($worker + "/")))] | length == 0
  ' "$evidence_dir/access-apps.json" >/dev/null || die "an Access app is attached to the intake Worker"
  booking_app_id="$(jq -r --arg domain "$BOOKING_DOMAIN" '.result[] | select(.domain==$domain) | .id' "$evidence_dir/access-apps.json" | head -n1)"
  crm_app_id="$(jq -r --arg domain "$CRM_DOMAIN" '.result[] | select(.domain==$domain) | .id' "$evidence_dir/access-apps.json" | head -n1)"
  [ -n "$booking_app_id" ] && [ -n "$crm_app_id" ] || die "staging Access app ids were absent"
  for pair in "booking:$booking_app_id" "crm:$crm_app_id"; do
    label="${pair%%:*}"; app_id="${pair#*:}"
    policy_file="$evidence_dir/${label}-access-policies.json"
    curl --silent --show-error "${auth_headers[@]}" \
      "$api/$access_scope_kind/$access_scope_id/access/apps/$app_id/policies" > "$policy_file"
    jq -e '
      .success == true
      and ([.result[] | select(.decision == "allow")] | length == 1)
      and ([.result[] | select(.decision == "bypass" or .decision == "service_auth")] | length == 0)
      and ([.result[] | select(.decision == "allow") | .include[]?] as $include
           | ($include | length) == 1 and all($include[]; has("email")))
    ' "$policy_file" >/dev/null || die "$label staging Access policy was not owner-only"
  done
else
  add_blocker 'Cloudflare deployment token lacks Access: Apps and Policies Read; owner-only policy contents were not independently re-read'
fi

# Ruleset control-plane reads require a separate Rulesets permission. Runtime
# probes remain authoritative for this validation if that permission is absent.
curl --silent --show-error "${auth_headers[@]}" \
  "$api/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$evidence_dir/waf.json"
waf_control_verified=false
if jq -e '.success == true' "$evidence_dir/waf.json" >/dev/null; then
  jq -e '[.result.rules[]? | select(.enabled)] | length > 0' "$evidence_dir/waf.json" >/dev/null \
    || die "no enabled custom WAF rule was returned"
  waf_control_verified=true
else
  add_blocker 'Cloudflare deployment token lacks Rulesets read permission; WAF configuration was verified by live path and method probes only'
fi

curl --silent --show-error "${auth_headers[@]}" \
  "$api/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "$evidence_dir/rate-limit.json"
rate_control_verified=false
if jq -e '.success == true' "$evidence_dir/rate-limit.json" >/dev/null; then
  jq -e '[.result.rules[]? | select(.enabled)] | length > 0' "$evidence_dir/rate-limit.json" >/dev/null \
    || die "no enabled rate-limit rule was returned"
  rate_control_verified=true
else
  add_blocker 'Cloudflare deployment token lacks Rulesets read permission; rate-limit configuration was verified by live 429 and recovery probes only'
fi

curl --silent --show-error "${auth_headers[@]}" \
  "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/$WORKER_NAME/environments/production/subdomain" \
  > "$evidence_dir/subdomain.json"
jq -e '.success == true and .result.enabled == false and .result.previews_enabled == false' \
  "$evidence_dir/subdomain.json" >/dev/null || die "workers.dev or Worker previews are enabled"

# Reset the known 10-second window before the active rate probe.
sleep 12
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
  --arg booking "$BOOKING_DOMAIN" --arg crm "$CRM_DOMAIN" --arg worker "$WORKER_HOST" \
  --argjson access_verified "$access_verified" --argjson waf_control_verified "$waf_control_verified" \
  --argjson rate_control_verified "$rate_control_verified" --argjson blockers "$blockers" \
  '{
    booking_access:{domain:$booking,redirect_gate:true,owner_only_control_plane_verified:$access_verified},
    crm_access:{domain:$crm,redirect_gate:true,owner_only_control_plane_verified:$access_verified},
    intake_worker:{domain:$worker,access_redirect:false,workers_dev:false},
    cors:{exact_staging_origin:true,wrong_origin_rejected:true},
    waf:{live_exact_path_and_methods:true,wrong_path_blocked:true,wrong_method_blocked:true,control_plane_verified:$waf_control_verified},
    rate_limit:{observed_429:true,recovered:true,control_plane_verified:$rate_control_verified},
    production_targeting:false,
    blockers:$blockers
  }' > "$evidence_dir/edge-evidence.json"
