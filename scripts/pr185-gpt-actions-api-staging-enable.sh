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
: "${CLOUDFLARE_ZONE_WAF_WRITE_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"

EXPECTED_ZONE='vishartattoo.com'
EXPECTED_HOST='gpt-actions-staging.vishartattoo.com'
EXPECTED_WORKER='vishar-gpt-actions-staging'
EXPECTED_SUPABASE_URL='https://gwaliusblwrzisrwnsvs.supabase.co'
WAF_DESCRIPTION_OLD='Vishar GPT OAuth staging path boundary'
WAF_DESCRIPTION_NEW='Vishar GPT Actions staging path boundary'
RATE_DESCRIPTION='staging-booking-rate-limit'

WAF_EXPRESSION_OLD='(http.host eq "gpt-actions-staging.vishartattoo.com" and not ((http.request.method eq "GET" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/")) or (http.request.method eq "HEAD" and (http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/")) or (http.request.method eq "POST" and (http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/"))))'
WAF_EXPRESSION_NEW='(http.host eq "gpt-actions-staging.vishartattoo.com" and not ((http.request.method eq "GET" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/" or http.request.uri.path eq "/v1/clients/search" or http.request.uri.path eq "/v1/appointments" or starts_with(http.request.uri.path, "/v1/appointments/"))) or (http.request.method eq "HEAD" and (http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/")) or (http.request.method eq "POST" and (http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/" or http.request.uri.path eq "/v1/appointments" or http.request.uri.path eq "/v1/appointments/conflicts" or (starts_with(http.request.uri.path, "/v1/appointments/") and ends_with(http.request.uri.path, "/cancel")))) or (http.request.method eq "PATCH" and starts_with(http.request.uri.path, "/v1/appointments/") and ends_with(http.request.uri.path, "/time"))))'
RATE_EXPRESSION_OLD='((http.request.uri.path eq "/__vishar-staging-intake-2026") or (http.host eq "gpt-actions-staging.vishartattoo.com" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/")))'
RATE_EXPRESSION_NEW='((http.request.uri.path eq "/__vishar-staging-intake-2026") or (http.host eq "gpt-actions-staging.vishartattoo.com" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/" or starts_with(http.request.uri.path, "/v1/"))))'

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
! grep -Eq 'service_role|SUPABASE_SECRET|SUPABASE_SERVICE|sb_secret_' workers/gpt-actions-staging.js workers/lib/gpt-actions.js wrangler.gpt-actions.staging.toml
! grep -Eq '(^|[[:space:]])routes[[:space:]]*=|custom_domain[[:space:]]*=' wrangler.gpt-actions.staging.toml

lookup_auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
edge_auth=(-H "Authorization: Bearer $CLOUDFLARE_EDGE_READ_TOKEN" -H 'Content-Type: application/json')
waf_write_auth=(-H "Authorization: Bearer $CLOUDFLARE_ZONE_WAF_WRITE_TOKEN" -H 'Content-Type: application/json')
safe="$RUNNER_TEMP/gpt-actions-api-enable-evidence.txt"
zone_json="$RUNNER_TEMP/zone.json"
dns_json="$RUNNER_TEMP/dns.json"
routes_json="$RUNNER_TEMP/routes.json"
domains_json="$RUNNER_TEMP/domains.json"
waf_json="$RUNNER_TEMP/waf.json"
rate_json="$RUNNER_TEMP/rate.json"
access_json="$RUNNER_TEMP/access.json"
deployments_json="$RUNNER_TEMP/deployments.json"
pre_version_json="$RUNNER_TEMP/pre-version.json"

curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/zones?name=$TARGET_ZONE" > "$zone_json"
zone_id="$(jq -r --arg name "$TARGET_ZONE" '[.result[] | select(.name == $name)] | if length == 1 then .[0].id else empty end' "$zone_json")"
[ -n "$zone_id" ] || { echo 'Exact Cloudflare zone not resolved.' >&2; exit 1; }
plan_legacy_id="$(jq -r --arg name "$TARGET_ZONE" '[.result[] | select(.name == $name)] | .[0].plan.legacy_id // "unknown"' "$zone_json")"
[ "$plan_legacy_id" = free ] || { echo "Unexpected Cloudflare plan '$plan_legacy_id'." >&2; exit 1; }

curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records?name=$TARGET_HOST&per_page=100" > "$dns_json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/workers/routes" > "$routes_json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" > "$domains_json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$waf_json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "$rate_json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" > "$access_json"
curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/deployments" > "$deployments_json"

dns_target="$(jq --arg host "$TARGET_HOST" '[.result[]? | select(.name == $host)] | length' "$dns_json")"
worker_routes="$(jq --arg worker "$WORKER_NAME" '[.result[]? | select((.script // "") == $worker)] | length' "$routes_json")"
target_routes="$(jq --arg host "$TARGET_HOST" '[.result[]? | select((.pattern // "") | contains($host))] | length' "$routes_json")"
target_domains="$(jq --arg host "$TARGET_HOST" --arg worker "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service == $worker)] | length' "$domains_json")"
other_target_domains="$(jq --arg host "$TARGET_HOST" --arg worker "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service != $worker)] | length' "$domains_json")"
access_target="$(jq --arg host "$TARGET_HOST" '[.result[]? | select((.domain // "") == $host or (.domain // "") == ($host + "/*"))] | length' "$access_json")"
waf_ruleset_id="$(jq -r '.result.id // empty' "$waf_json")"
waf_rule_id="$(jq -r --arg description "$WAF_DESCRIPTION_OLD" --arg expression "$WAF_EXPRESSION_OLD" '.result.rules[]? | select(.description == $description and .action == "block" and (.enabled // true) == true and .expression == $expression) | .id' "$waf_json")"
waf_exact_count="$(jq --arg description "$WAF_DESCRIPTION_OLD" --arg expression "$WAF_EXPRESSION_OLD" '[.result.rules[]? | select(.description == $description and .action == "block" and (.enabled // true) == true and .expression == $expression)] | length' "$waf_json")"
waf_target_count="$(jq --arg host "$TARGET_HOST" '[.result.rules[]? | select((.expression // "") | contains($host))] | length' "$waf_json")"
rate_ruleset_id="$(jq -r '.result.id // empty' "$rate_json")"
rate_rule_id="$(jq -r --arg description "$RATE_DESCRIPTION" --arg expression "$RATE_EXPRESSION_OLD" '.result.rules[]? | select(.description == $description and .action == "block" and (.enabled // true) == true and .expression == $expression and .ratelimit.period == 10 and .ratelimit.requests_per_period == 5 and .ratelimit.mitigation_timeout == 10 and ((.ratelimit.characteristics | sort) == (["cf.colo.id","ip.src"] | sort))) | .id' "$rate_json")"
rate_exact_count="$(jq --arg description "$RATE_DESCRIPTION" --arg expression "$RATE_EXPRESSION_OLD" '[.result.rules[]? | select(.description == $description and .action == "block" and (.enabled // true) == true and .expression == $expression and .ratelimit.period == 10 and .ratelimit.requests_per_period == 5 and .ratelimit.mitigation_timeout == 10 and ((.ratelimit.characteristics | sort) == (["cf.colo.id","ip.src"] | sort)))] | length' "$rate_json")"
rate_total="$(jq '[.result.rules[]?] | length' "$rate_json")"
pre_active_version_id="$(jq -r '.result.deployments[0].versions | map(select(.percentage == 100)) | if length == 1 then .[0].version_id else empty end' "$deployments_json")"

[ "$dns_target" = 1 ] || { echo "Expected one target DNS record, found $dns_target." >&2; exit 1; }
[ "$worker_routes" = 0 ] || { echo 'Worker route bindings are not zero.' >&2; exit 1; }
[ "$target_routes" = 0 ] || { echo 'Target host unexpectedly appears in Worker routes.' >&2; exit 1; }
[ "$target_domains" = 1 ] || { echo 'Exact target custom domain binding is not singular.' >&2; exit 1; }
[ "$other_target_domains" = 0 ] || { echo 'Target custom domain points to another Worker.' >&2; exit 1; }
[ "$access_target" = 0 ] || { echo 'Unexpected Cloudflare Access app on GPT endpoint.' >&2; exit 1; }
[ "$waf_target_count" = 1 ] || { echo 'Expected exactly one target-host WAF rule.' >&2; exit 1; }
[ "$waf_exact_count" = 1 ] && [ -n "$waf_rule_id" ] && [ -n "$waf_ruleset_id" ] || { echo 'Current WAF rule differs from verified OAuth-only boundary.' >&2; exit 1; }
[ "$rate_total" = 1 ] || { echo "Free plan expected one shared rate-limit rule, found $rate_total." >&2; exit 1; }
[ "$rate_exact_count" = 1 ] && [ -n "$rate_rule_id" ] && [ -n "$rate_ruleset_id" ] || { echo 'Current shared rate-limit rule differs from verified boundary.' >&2; exit 1; }
[ -n "$pre_active_version_id" ] || { echo 'Unable to resolve active Worker version.' >&2; exit 1; }

curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/versions/$pre_active_version_id" > "$pre_version_json"
pre_actions="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_ACTIONS_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$pre_version_json")"
pre_relay="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_OAUTH_RELAY_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$pre_version_json")"
pre_url="$(jq -jr '[.result.resources.bindings[]? | select(.name == "SUPABASE_URL")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$pre_version_json")"
pre_key_type="$(jq -jr '[.result.resources.bindings[]? | select(.name == "SUPABASE_PUBLISHABLE_KEY")] | if length == 1 then (.[0].type // "missing") else "missing" end' "$pre_version_json")"
[ "$pre_actions" = false ] || { echo 'Pre-active Worker actions are not disabled.' >&2; exit 1; }
[ "$pre_relay" = true ] || { echo 'Pre-active OAuth relay is not enabled.' >&2; exit 1; }
[ "$pre_url" = "$EXPECTED_SUPABASE_URL" ] || { echo 'Pre-active Worker Supabase URL differs from retained staging.' >&2; exit 1; }
[ "$pre_key_type" = plain_text ] || { echo 'Unexpected publishable-key binding type.' >&2; exit 1; }

cat > "$safe" <<EVIDENCE
exact_sha=$APPROVED_SHA
target_zone=$TARGET_ZONE
target_host=$TARGET_HOST
worker=$WORKER_NAME
pre_active_version_id=$pre_active_version_id
pre_GPT_ACTIONS_ENABLED=$pre_actions
pre_GPT_OAUTH_RELAY_ENABLED=$pre_relay
pre_dns_record_count=$dns_target
pre_worker_route_binding_count=$worker_routes
pre_target_route_count=$target_routes
pre_target_custom_domain_count=$target_domains
pre_target_waf_rule_count=$waf_target_count
pre_shared_rate_rule_count=$rate_total
pre_target_access_app_count=$access_target
waf_updated=false
rate_updated=false
worker_updated=false
rollback_attempted=false
cloudflare_mutated=false
production_targeted=false
EVIDENCE

jq -n --arg description "$WAF_DESCRIPTION_OLD" --arg expression "$WAF_EXPRESSION_OLD" '{description:$description,expression:$expression,action:"block",enabled:true}' > "$RUNNER_TEMP/waf-old.json"
jq -n --arg description "$WAF_DESCRIPTION_NEW" --arg expression "$WAF_EXPRESSION_NEW" '{description:$description,expression:$expression,action:"block",enabled:true}' > "$RUNNER_TEMP/waf-new.json"
jq -n --arg expression "$RATE_EXPRESSION_OLD" '{description:"staging-booking-rate-limit",expression:$expression,action:"block",enabled:true,ratelimit:{characteristics:["ip.src","cf.colo.id"],period:10,requests_per_period:5,mitigation_timeout:10}}' > "$RUNNER_TEMP/rate-old.json"
jq -n --arg expression "$RATE_EXPRESSION_NEW" '{description:"staging-booking-rate-limit",expression:$expression,action:"block",enabled:true,ratelimit:{characteristics:["ip.src","cf.colo.id"],period:10,requests_per_period:5,mitigation_timeout:10}}' > "$RUNNER_TEMP/rate-new.json"

waf_changed=false
rate_changed=false
worker_changed=false
complete=false

rollback() {
  original_status=$?
  if [ "$complete" = true ]; then return "$original_status"; fi
  set +e
  sed -i 's/^rollback_attempted=.*/rollback_attempted=true/' "$safe"

  if [ "$worker_changed" = true ]; then
    rollback_worker_status=0
    npx wrangler rollback "$pre_active_version_id" --name "$WORKER_NAME" --message "PR185 GPT Actions API staging rollback" > "$RUNNER_TEMP/worker-rollback.log" 2>&1 || rollback_worker_status=$?
    printf 'rollback_worker_version_id=%s\nrollback_worker_status=%s\n' "$pre_active_version_id" "$rollback_worker_status" >> "$safe"
  fi

  if [ "$rate_changed" = true ]; then
    rate_restore_status="$(curl --silent --show-error -o "$RUNNER_TEMP/rate-restore.json" -w '%{http_code}' "${waf_write_auth[@]}" -X PATCH --data-binary @"$RUNNER_TEMP/rate-old.json" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$rate_ruleset_id/rules/$rate_rule_id" || true)"
    printf 'rollback_rate_restore_status=%s\n' "$rate_restore_status" >> "$safe"
  fi

  if [ "$waf_changed" = true ]; then
    waf_restore_status="$(curl --silent --show-error -o "$RUNNER_TEMP/waf-restore.json" -w '%{http_code}' "${waf_write_auth[@]}" -X PATCH --data-binary @"$RUNNER_TEMP/waf-old.json" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$waf_ruleset_id/rules/$waf_rule_id" || true)"
    printf 'rollback_waf_restore_status=%s\n' "$waf_restore_status" >> "$safe"
  fi

  printf 'cloudflare_mutated=true\nproduction_targeted=false\n' >> "$safe"
  return "$original_status"
}
trap rollback EXIT

waf_changed=true
waf_patch_status="$(curl --silent --show-error -o "$RUNNER_TEMP/waf-patch.json" -w '%{http_code}' "${waf_write_auth[@]}" -X PATCH --data-binary @"$RUNNER_TEMP/waf-new.json" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$waf_ruleset_id/rules/$waf_rule_id" || true)"
[ "$waf_patch_status" = 200 ] || { echo "Unable to expand staging WAF boundary, HTTP $waf_patch_status." >&2; exit 1; }
jq -e '.success == true' "$RUNNER_TEMP/waf-patch.json" >/dev/null
sed -i 's/^waf_updated=.*/waf_updated=true/' "$safe"

rate_changed=true
rate_patch_status="$(curl --silent --show-error -o "$RUNNER_TEMP/rate-patch.json" -w '%{http_code}' "${waf_write_auth[@]}" -X PATCH --data-binary @"$RUNNER_TEMP/rate-new.json" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$rate_ruleset_id/rules/$rate_rule_id" || true)"
[ "$rate_patch_status" = 200 ] || { echo "Unable to extend shared staging rate limit, HTTP $rate_patch_status." >&2; exit 1; }
jq -e '.success == true' "$RUNNER_TEMP/rate-patch.json" >/dev/null
sed -i 's/^rate_updated=.*/rate_updated=true/' "$safe"

npx wrangler deploy --config wrangler.gpt-actions.staging.toml --dry-run --outdir "$RUNNER_TEMP/gpt-actions-api-dry-run" --var SUPABASE_URL:"$STAGING_SUPABASE_URL" --var SUPABASE_PUBLISHABLE_KEY:"$STAGING_SUPABASE_PUBLISHABLE_KEY" --var GPT_ACTIONS_ENABLED:true --var GPT_OAUTH_RELAY_ENABLED:true >/dev/null
worker_changed=true
npx wrangler deploy --config wrangler.gpt-actions.staging.toml --var SUPABASE_URL:"$STAGING_SUPABASE_URL" --var SUPABASE_PUBLISHABLE_KEY:"$STAGING_SUPABASE_PUBLISHABLE_KEY" --var GPT_ACTIONS_ENABLED:true --var GPT_OAUTH_RELAY_ENABLED:true | tee "$RUNNER_TEMP/worker-deploy.log"
sed -i 's/^worker_updated=.*/worker_updated=true/' "$safe"

active_version_id=''
for attempt in $(seq 1 24); do
  curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/deployments" > "$RUNNER_TEMP/deployments-after.json"
  candidate="$(jq -r '.result.deployments[0].versions | map(select(.percentage == 100)) | if length == 1 then .[0].version_id else empty end' "$RUNNER_TEMP/deployments-after.json")"
  if [ -n "$candidate" ] && [ "$candidate" != "$pre_active_version_id" ]; then
    active_version_id="$candidate"
    break
  fi
  sleep 5
done
[ -n "$active_version_id" ] || { echo 'New active Worker version did not become visible.' >&2; exit 1; }

curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/versions/$active_version_id" > "$RUNNER_TEMP/active-version.json"
active_actions="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_ACTIONS_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$RUNNER_TEMP/active-version.json")"
active_relay="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_OAUTH_RELAY_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$RUNNER_TEMP/active-version.json")"
active_url="$(jq -jr '[.result.resources.bindings[]? | select(.name == "SUPABASE_URL")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$RUNNER_TEMP/active-version.json")"
[ "$active_actions" = true ] || { echo 'Active Worker did not enable GPT actions.' >&2; exit 1; }
[ "$active_relay" = true ] || { echo 'Active Worker lost OAuth relay.' >&2; exit 1; }
[ "$active_url" = "$EXPECTED_SUPABASE_URL" ] || { echo 'Active Worker Supabase URL differs from retained staging.' >&2; exit 1; }

wait_http_status() {
  expected="$1"
  label="$2"
  shift 2
  last='000'
  for attempt in $(seq 1 18); do
    last="$(curl --silent --show-error -o /dev/null -w '%{http_code}' "$@" || true)"
    if [ "$last" = "$expected" ]; then
      printf '%s' "$last"
      return 0
    fi
    sleep 5
  done
  echo "$label returned $last instead of $expected after propagation retries." >&2
  return 1
}

privacy_status="$(wait_http_status 200 privacy "https://$TARGET_HOST/privacy")"
token_guard_status="$(wait_http_status 415 token-guard -X POST -H 'Content-Type: application/json' --data '{}' "https://$TARGET_HOST/oauth/token")"
action_unauth_status="$(wait_http_status 401 unauthenticated-action "https://$TARGET_HOST/v1/appointments?from=2026-08-10T00%3A00%3A00Z&to=2026-08-11T00%3A00%3A00Z")"
disallowed_method_status="$(wait_http_status 403 disallowed-method -X DELETE "https://$TARGET_HOST/v1/appointments")"
disallowed_path_status="$(wait_http_status 403 disallowed-path "https://$TARGET_HOST/v1/not-approved")"

curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/workers/routes" > "$RUNNER_TEMP/routes-after.json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" > "$RUNNER_TEMP/domains-after.json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$RUNNER_TEMP/waf-after.json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "$RUNNER_TEMP/rate-after.json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" > "$RUNNER_TEMP/access-after.json"

post_worker_routes="$(jq --arg worker "$WORKER_NAME" '[.result[]? | select((.script // "") == $worker)] | length' "$RUNNER_TEMP/routes-after.json")"
post_target_routes="$(jq --arg host "$TARGET_HOST" '[.result[]? | select((.pattern // "") | contains($host))] | length' "$RUNNER_TEMP/routes-after.json")"
post_domains="$(jq --arg host "$TARGET_HOST" --arg worker "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service == $worker)] | length' "$RUNNER_TEMP/domains-after.json")"
post_waf="$(jq --arg description "$WAF_DESCRIPTION_NEW" --arg expression "$WAF_EXPRESSION_NEW" '[.result.rules[]? | select(.description == $description and .expression == $expression and .action == "block" and (.enabled // true) == true)] | length' "$RUNNER_TEMP/waf-after.json")"
post_rate="$(jq --arg description "$RATE_DESCRIPTION" --arg expression "$RATE_EXPRESSION_NEW" '[.result.rules[]? | select(.description == $description and .expression == $expression and .action == "block" and (.enabled // true) == true and .ratelimit.period == 10 and .ratelimit.requests_per_period == 5 and .ratelimit.mitigation_timeout == 10)] | length' "$RUNNER_TEMP/rate-after.json")"
post_rate_total="$(jq '[.result.rules[]?] | length' "$RUNNER_TEMP/rate-after.json")"
post_access="$(jq --arg host "$TARGET_HOST" '[.result[]? | select((.domain // "") == $host or (.domain // "") == ($host + "/*"))] | length' "$RUNNER_TEMP/access-after.json")"

[ "$post_worker_routes" = 0 ]
[ "$post_target_routes" = 0 ]
[ "$post_domains" = 1 ]
[ "$post_waf" = 1 ]
[ "$post_rate" = 1 ]
[ "$post_rate_total" = 1 ]
[ "$post_access" = 0 ]

cat >> "$safe" <<EVIDENCE
active_version_id=$active_version_id
active_GPT_ACTIONS_ENABLED=$active_actions
active_GPT_OAUTH_RELAY_ENABLED=$active_relay
privacy_status=$privacy_status
token_content_type_guard_status=$token_guard_status
unauthenticated_action_status=$action_unauth_status
disallowed_method_waf_status=$disallowed_method_status
disallowed_path_waf_status=$disallowed_path_status
post_worker_route_binding_count=$post_worker_routes
post_target_route_count=$post_target_routes
post_target_custom_domain_count=$post_domains
post_target_waf_rule_count=$post_waf
post_shared_rate_rule_count=$post_rate_total
post_exact_actions_rate_rule_count=$post_rate
post_target_access_app_count=$post_access
cloudflare_mutated=true
production_targeted=false
EVIDENCE

complete=true
trap - EXIT
