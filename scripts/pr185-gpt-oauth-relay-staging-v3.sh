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

EXPECTED_SUPABASE_URL='https://gwaliusblwrzisrwnsvs.supabase.co'
EXPECTED_WORKER='vishar-gpt-actions-staging'
EXPECTED_HOST='gpt-actions-staging.vishartattoo.com'
EXPECTED_ZONE='vishartattoo.com'
ORIGINAL_RATE_EXPRESSION='(http.request.uri.path eq "/__vishar-staging-intake-2026")'
COMBINED_RATE_EXPRESSION='((http.request.uri.path eq "/__vishar-staging-intake-2026") or (http.host eq "gpt-actions-staging.vishartattoo.com" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/")))'
WAF_EXPRESSION='(http.host eq "gpt-actions-staging.vishartattoo.com" and not ((http.request.method eq "GET" and (http.request.uri.path eq "/oauth/authorize" or http.request.uri.path eq "/oauth/authorize/" or http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/")) or (http.request.method eq "HEAD" and (http.request.uri.path eq "/privacy" or http.request.uri.path eq "/privacy/")) or (http.request.method eq "POST" and (http.request.uri.path eq "/oauth/token" or http.request.uri.path eq "/oauth/token/"))))'
WAF_DESCRIPTION='Vishar GPT OAuth staging path boundary'
RATE_DESCRIPTION='staging-booking-rate-limit'

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
grep -Fq "const RETAINED_STAGING_SUPABASE_ORIGIN = 'https://gwaliusblwrzisrwnsvs.supabase.co';" workers/gpt-actions-staging.js
! grep -Eq 'service_role|SUPABASE_SECRET|SUPABASE_SERVICE|sb_secret_' workers/gpt-actions-staging.js wrangler.gpt-actions.staging.toml
! grep -Eq '(^|[[:space:]])routes[[:space:]]*=|custom_domain[[:space:]]*=' wrangler.gpt-actions.staging.toml

lookup_auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
edge_auth=(-H "Authorization: Bearer $CLOUDFLARE_EDGE_READ_TOKEN" -H 'Content-Type: application/json')
waf_write_auth=(-H "Authorization: Bearer $CLOUDFLARE_ZONE_WAF_WRITE_TOKEN" -H 'Content-Type: application/json')

safe="$RUNNER_TEMP/relay-v3-evidence.txt"
zone_json="$RUNNER_TEMP/zone.json"
dns_json="$RUNNER_TEMP/dns.json"
routes_json="$RUNNER_TEMP/routes.json"
domains_json="$RUNNER_TEMP/domains.json"
waf_json="$RUNNER_TEMP/waf.json"
rate_json="$RUNNER_TEMP/rate.json"
access_json="$RUNNER_TEMP/access.json"
deployments_json="$RUNNER_TEMP/deployments-before.json"
pre_active_version_json="$RUNNER_TEMP/pre-active-version.json"

curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/zones?name=$TARGET_ZONE" > "$zone_json"
zone_id="$(jq -r --arg name "$TARGET_ZONE" '[.result[] | select(.name == $name)] | if length == 1 then .[0].id else empty end' "$zone_json")"
[ -n "$zone_id" ] || { echo 'Exact Cloudflare zone not resolved.' >&2; exit 1; }
plan_legacy_id="$(jq -r --arg name "$TARGET_ZONE" '[.result[] | select(.name == $name)] | .[0].plan.legacy_id // "unknown"' "$zone_json")"
plan_name="$(jq -jr --arg name "$TARGET_ZONE" '[.result[] | select(.name == $name)] | .[0].plan.name // "unknown"' "$zone_json")"
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
target_domains="$(jq --arg host "$TARGET_HOST" '[.result[]? | select(.hostname == $host)] | length' "$domains_json")"
waf_target="$(jq --arg host "$TARGET_HOST" '[.result.rules[]? | select((.expression // "") | contains($host))] | length' "$waf_json")"
access_target="$(jq --arg host "$TARGET_HOST" '[.result[]? | select((.domain // "") == $host or (.domain // "") == ($host + "/*"))] | length' "$access_json")"
rate_total="$(jq '[.result.rules[]?] | length' "$rate_json")"
rate_target="$(jq --arg host "$TARGET_HOST" '[.result.rules[]? | select((.expression // "") | contains($host))] | length' "$rate_json")"
exact_booking_rate="$(jq --arg expression "$ORIGINAL_RATE_EXPRESSION" '[.result.rules[]? | select(.description == "staging-booking-rate-limit" and (.enabled // true) == true and .action == "block" and .expression == $expression and .ratelimit.period == 10 and .ratelimit.requests_per_period == 5 and .ratelimit.mitigation_timeout == 10 and ((.ratelimit.characteristics | sort) == (["cf.colo.id","ip.src"] | sort)))] | length' "$rate_json")"
rate_ruleset_id="$(jq -r '.result.id // empty' "$rate_json")"
booking_rate_rule_id="$(jq -r --arg expression "$ORIGINAL_RATE_EXPRESSION" '.result.rules[]? | select(.description == "staging-booking-rate-limit" and .expression == $expression) | .id' "$rate_json")"
waf_ruleset_id="$(jq -r '.result.id // empty' "$waf_json")"
pre_active_version_id="$(jq -r '.result.deployments[0].versions | map(select(.percentage == 100)) | if length == 1 then .[0].version_id else empty end' "$deployments_json")"

[ "$dns_target" = 0 ] || { echo 'Target DNS record already exists.' >&2; exit 1; }
[ "$worker_routes" = 0 ] || { echo 'Worker already has route bindings.' >&2; exit 1; }
[ "$target_routes" = 0 ] || { echo 'Target host already appears in a Worker route.' >&2; exit 1; }
[ "$target_domains" = 0 ] || { echo 'Target custom domain already exists.' >&2; exit 1; }
[ "$waf_target" = 0 ] || { echo 'Target WAF rule already exists.' >&2; exit 1; }
[ "$access_target" = 0 ] || { echo 'Target Access app already exists.' >&2; exit 1; }
[ "$rate_total" = 1 ] || { echo "Free plan expected exactly one rate-limit rule, found $rate_total." >&2; exit 1; }
[ "$rate_target" = 0 ] || { echo 'GPT hostname already appears in rate-limit rule.' >&2; exit 1; }
[ "$exact_booking_rate" = 1 ] || { echo 'Existing booking rate-limit rule differs from verified 5/10/10 boundary.' >&2; exit 1; }
[ -n "$rate_ruleset_id" ]
[ -n "$booking_rate_rule_id" ]
[ -n "$waf_ruleset_id" ]
[ -n "$pre_active_version_id" ] || { echo 'Unable to resolve one pre-activation active Worker version.' >&2; exit 1; }

curl --fail --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/versions/$pre_active_version_id" > "$pre_active_version_json"
pre_actions="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_ACTIONS_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$pre_active_version_json")"
pre_relay="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_OAUTH_RELAY_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$pre_active_version_json")"
[ "$pre_actions" = false ] || { echo 'Pre-active Worker actions are not disabled.' >&2; exit 1; }
[ "$pre_relay" = false ] || { echo 'Pre-active Worker relay is not disabled.' >&2; exit 1; }

cat > "$safe" <<EOF
exact_sha=$APPROVED_SHA
target_zone=$TARGET_ZONE
target_host=$TARGET_HOST
worker=$WORKER_NAME
zone_plan_name=$plan_name
zone_plan_legacy_id=$plan_legacy_id
pre_active_version_id=$pre_active_version_id
pre_active_GPT_ACTIONS_ENABLED=$pre_actions
pre_active_GPT_OAUTH_RELAY_ENABLED=$pre_relay
pre_target_dns_record_count=$dns_target
pre_worker_route_binding_count=$worker_routes
pre_target_route_count=$target_routes
pre_target_custom_domain_count=$target_domains
pre_target_waf_rule_count=$waf_target
pre_rate_limit_total_rule_count=$rate_total
pre_target_rate_rule_count=$rate_target
pre_exact_booking_rate_rule_count=$exact_booking_rate
pre_target_access_app_count=$access_target
rollback_attempted=false
cloudflare_mutated=false
production_targeted=false
EOF

jq -n --arg expression "$ORIGINAL_RATE_EXPRESSION" '{description:"staging-booking-rate-limit",expression:$expression,action:"block",enabled:true,ratelimit:{characteristics:["ip.src","cf.colo.id"],period:10,requests_per_period:5,mitigation_timeout:10}}' > "$RUNNER_TEMP/rate-original.json"
jq -n --arg expression "$COMBINED_RATE_EXPRESSION" '{description:"staging-booking-rate-limit",expression:$expression,action:"block",enabled:true,ratelimit:{characteristics:["ip.src","cf.colo.id"],period:10,requests_per_period:5,mitigation_timeout:10}}' > "$RUNNER_TEMP/rate-combined.json"

waf_rule_id=''
domain_id=''
domain_changed=false
worker_changed=false
rate_changed=false
complete=false

rollback() {
  original_status=$?
  if [ "$complete" = true ]; then return "$original_status"; fi
  set +e
  sed -i 's/^rollback_attempted=.*/rollback_attempted=true/' "$safe"

  if [ "$domain_changed" = true ]; then
    if [ -z "$domain_id" ]; then
      curl --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" > "$RUNNER_TEMP/rollback-domains.json"
      domain_id="$(jq -r --arg host "$TARGET_HOST" --arg service "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service == $service)] | if length == 1 then .[0].id else empty end' "$RUNNER_TEMP/rollback-domains.json")"
    fi
    domain_delete_status=not_found
    if [ -n "$domain_id" ]; then
      domain_delete_status="$(curl --silent --show-error -o "$RUNNER_TEMP/domain-delete.json" -w '%{http_code}' "${lookup_auth[@]}" -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains/$domain_id" || true)"
    fi
    printf 'rollback_domain_delete_status=%s\n' "$domain_delete_status" >> "$safe"
  fi

  if [ "$worker_changed" = true ]; then
    rollback_worker_status=0
    npx wrangler rollback "$pre_active_version_id" --name "$WORKER_NAME" --message "PR185 staging OAuth relay rollback" > "$RUNNER_TEMP/worker-rollback.log" 2>&1 || rollback_worker_status=$?
    printf 'rollback_worker_version_id=%s\nrollback_worker_status=%s\n' "$pre_active_version_id" "$rollback_worker_status" >> "$safe"
  fi

  if [ "$rate_changed" = true ]; then
    rate_restore_status="$(curl --silent --show-error -o "$RUNNER_TEMP/rate-restore.json" -w '%{http_code}' "${waf_write_auth[@]}" -X PATCH --data-binary @"$RUNNER_TEMP/rate-original.json" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$rate_ruleset_id/rules/$booking_rate_rule_id" || true)"
    printf 'rollback_rate_restore_status=%s\n' "$rate_restore_status" >> "$safe"
  fi

  if [ -n "$waf_rule_id" ]; then
    waf_delete_status="$(curl --silent --show-error -o "$RUNNER_TEMP/waf-delete.json" -w '%{http_code}' "${waf_write_auth[@]}" -X DELETE "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$waf_ruleset_id/rules/$waf_rule_id" || true)"
    printf 'rollback_waf_delete_status=%s\n' "$waf_delete_status" >> "$safe"
  fi

  curl --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" > "$RUNNER_TEMP/rollback-domains-after.json"
  curl --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$RUNNER_TEMP/rollback-waf-after.json"
  curl --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "$RUNNER_TEMP/rollback-rate-after.json"
  curl --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/deployments" > "$RUNNER_TEMP/rollback-deployments-after.json"
  rollback_domains="$(jq --arg host "$TARGET_HOST" '[.result[]? | select(.hostname == $host)] | length' "$RUNNER_TEMP/rollback-domains-after.json" 2>/dev/null || echo unknown)"
  rollback_waf="$(jq --arg host "$TARGET_HOST" '[.result.rules[]? | select((.expression // "") | contains($host))] | length' "$RUNNER_TEMP/rollback-waf-after.json" 2>/dev/null || echo unknown)"
  rollback_rate_target="$(jq --arg host "$TARGET_HOST" '[.result.rules[]? | select((.expression // "") | contains($host))] | length' "$RUNNER_TEMP/rollback-rate-after.json" 2>/dev/null || echo unknown)"
  rollback_rate_original="$(jq --arg expression "$ORIGINAL_RATE_EXPRESSION" '[.result.rules[]? | select(.description == "staging-booking-rate-limit" and .expression == $expression and .ratelimit.period == 10 and .ratelimit.requests_per_period == 5 and .ratelimit.mitigation_timeout == 10)] | length' "$RUNNER_TEMP/rollback-rate-after.json" 2>/dev/null || echo unknown)"
  rollback_active_version="$(jq -r '.result.deployments[0].versions | map(select(.percentage == 100)) | if length == 1 then .[0].version_id else "unknown" end' "$RUNNER_TEMP/rollback-deployments-after.json" 2>/dev/null || echo unknown)"
  printf 'rollback_post_target_custom_domain_count=%s\nrollback_post_target_waf_rule_count=%s\nrollback_post_target_rate_rule_count=%s\nrollback_post_original_booking_rate_rule_count=%s\nrollback_post_active_version_id=%s\n' "$rollback_domains" "$rollback_waf" "$rollback_rate_target" "$rollback_rate_original" "$rollback_active_version" >> "$safe"
  return "$original_status"
}
trap rollback EXIT

jq -n --arg expression "$WAF_EXPRESSION" --arg description "$WAF_DESCRIPTION" '{description:$description,expression:$expression,action:"block",enabled:true}' > "$RUNNER_TEMP/waf-create.json"
waf_status="$(curl --silent --show-error -o "$RUNNER_TEMP/waf-create-response.json" -w '%{http_code}' "${waf_write_auth[@]}" -X POST --data-binary @"$RUNNER_TEMP/waf-create.json" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$waf_ruleset_id/rules" || true)"
[ "$waf_status" = 200 ] || { echo "Unable to create staging WAF rule, HTTP $waf_status." >&2; exit 1; }

curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$RUNNER_TEMP/waf-after-create.json"
exact_waf_count="$(jq --arg description "$WAF_DESCRIPTION" --arg expression "$WAF_EXPRESSION" '[.result.rules[]? | select(.description == $description and .expression == $expression and (.enabled // true) == true and .action == "block")] | length' "$RUNNER_TEMP/waf-after-create.json")"
[ "$exact_waf_count" = 1 ] || { echo "Expected exactly one newly-created staging WAF rule, found $exact_waf_count." >&2; exit 1; }
waf_rule_id="$(jq -r --arg description "$WAF_DESCRIPTION" --arg expression "$WAF_EXPRESSION" '.result.rules[]? | select(.description == $description and .expression == $expression) | .id' "$RUNNER_TEMP/waf-after-create.json")"
[ -n "$waf_rule_id" ] || { echo 'Unable to resolve actual WAF rule ID after creation.' >&2; exit 1; }
printf 'waf_create_status=200\nactual_waf_rule_resolved=true\n' >> "$safe"

rate_patch_status="$(curl --silent --show-error -o "$RUNNER_TEMP/rate-patch-response.json" -w '%{http_code}' "${waf_write_auth[@]}" -X PATCH --data-binary @"$RUNNER_TEMP/rate-combined.json" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/$rate_ruleset_id/rules/$booking_rate_rule_id" || true)"
[ "$rate_patch_status" = 200 ] || {
  rate_errors="$(jq -r '[.errors[]? | ((.code // "unknown")|tostring) + ":" + (.message // "unknown")] | if length == 0 then "none" else join(" | ") end' "$RUNNER_TEMP/rate-patch-response.json" 2>/dev/null | tr '\n\r=' '   ')"
  printf 'rate_patch_status=%s\nrate_patch_errors=%s\n' "$rate_patch_status" "$rate_errors" >> "$safe"
  echo "Unable to extend existing staging rate-limit rule, HTTP $rate_patch_status: $rate_errors" >&2
  exit 1
}
rate_changed=true
printf 'rate_patch_status=200\nshared_rate_limit_period=10\nshared_rate_limit_requests=5\nshared_rate_limit_mitigation=10\n' >> "$safe"

npx wrangler deploy --config wrangler.gpt-actions.staging.toml --dry-run --outdir "$RUNNER_TEMP/gpt-oauth-relay-v3-dry-run" --var SUPABASE_URL:"$STAGING_SUPABASE_URL" --var SUPABASE_PUBLISHABLE_KEY:"$STAGING_SUPABASE_PUBLISHABLE_KEY" --var GPT_ACTIONS_ENABLED:false --var GPT_OAUTH_RELAY_ENABLED:true >/dev/null
npx wrangler deploy --config wrangler.gpt-actions.staging.toml --var SUPABASE_URL:"$STAGING_SUPABASE_URL" --var SUPABASE_PUBLISHABLE_KEY:"$STAGING_SUPABASE_PUBLISHABLE_KEY" --var GPT_ACTIONS_ENABLED:false --var GPT_OAUTH_RELAY_ENABLED:true | tee "$RUNNER_TEMP/worker-deploy.log"
worker_changed=true

relay_active=false
relay_version_id=''
for attempt in $(seq 1 24); do
  curl --silent --show-error "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/deployments" > "$RUNNER_TEMP/deployments-after-worker.json"
  candidate="$(jq -r '.result.deployments[0].versions | map(select(.percentage == 100)) | if length == 1 then .[0].version_id else empty end' "$RUNNER_TEMP/deployments-after-worker.json")"
  if [ -n "$candidate" ] && [ "$candidate" != "$pre_active_version_id" ]; then
    candidate_status="$(curl --silent --show-error -o "$RUNNER_TEMP/candidate-version.json" -w '%{http_code}' "${lookup_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/versions/$candidate" || true)"
    if [ "$candidate_status" = 200 ]; then
      candidate_actions="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_ACTIONS_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$RUNNER_TEMP/candidate-version.json")"
      candidate_relay="$(jq -jr '[.result.resources.bindings[]? | select(.name == "GPT_OAUTH_RELAY_ENABLED")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$RUNNER_TEMP/candidate-version.json")"
      candidate_supabase="$(jq -jr '[.result.resources.bindings[]? | select(.name == "SUPABASE_URL")] | if length == 1 and .[0].type == "plain_text" then (.[0].text // "") else "missing" end' "$RUNNER_TEMP/candidate-version.json")"
      if [ "$candidate_actions" = false ] && [ "$candidate_relay" = true ] && [ "$candidate_supabase" = "$EXPECTED_SUPABASE_URL" ]; then
        relay_active=true
        relay_version_id="$candidate"
        break
      fi
    fi
  fi
  sleep 2
done
[ "$relay_active" = true ] || { echo 'Relay-enabled Worker version did not become the 100% active deployment.' >&2; exit 1; }
printf 'relay_active_version_id=%s\nrelay_control_plane_ready=true\n' "$relay_version_id" >> "$safe"

jq -n --arg host "$TARGET_HOST" --arg service "$WORKER_NAME" --arg zone_id "$zone_id" --arg zone_name "$TARGET_ZONE" '{hostname:$host,service:$service,zone_id:$zone_id,zone_name:$zone_name}' > "$RUNNER_TEMP/domain-create.json"
domain_status="$(curl --silent --show-error -o "$RUNNER_TEMP/domain-create-response.json" -w '%{http_code}' "${lookup_auth[@]}" -X PUT --data-binary @"$RUNNER_TEMP/domain-create.json" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" || true)"
[ "$domain_status" = 200 ] || { echo "Unable to attach staging Worker custom domain, HTTP $domain_status." >&2; exit 1; }
domain_changed=true
domain_id="$(jq -r '.result.id // empty' "$RUNNER_TEMP/domain-create-response.json")"

ready=false
for attempt in $(seq 1 36); do
  if curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" > "$RUNNER_TEMP/domains-after.json"; then
    count="$(jq --arg host "$TARGET_HOST" --arg service "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service == $service)] | length' "$RUNNER_TEMP/domains-after.json")"
    if [ "$count" = 1 ]; then ready=true; break; fi
  fi
  sleep 5
done
[ "$ready" = true ] || { echo 'Custom domain did not become visible through read API.' >&2; exit 1; }

authorize_status='000'
authorize_attempts=0
for attempt in $(seq 1 36); do
  authorize_attempts="$attempt"
  authorize_status="$(curl --silent --show-error --max-time 10 --max-redirs 0 -D "$RUNNER_TEMP/authorize-headers.txt" -o /dev/null -w '%{http_code}' "https://$TARGET_HOST/oauth/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback&state=synthetic-state&code_challenge=synthetic-challenge&code_challenge_method=S256" || true)"
  if [ "$authorize_status" = 302 ] && grep -Fqi "location: $EXPECTED_SUPABASE_URL/auth/v1/oauth/authorize?" "$RUNNER_TEMP/authorize-headers.txt"; then
    break
  fi
  sleep 5
done
printf 'authorize_attempts=%s\nauthorize_status=%s\n' "$authorize_attempts" "$authorize_status" >> "$safe"
[ "$authorize_status" = 302 ] || { echo "OAuth authorize relay did not become ready, last HTTP $authorize_status." >&2; exit 1; }
grep -Fqi "location: $EXPECTED_SUPABASE_URL/auth/v1/oauth/authorize?" "$RUNNER_TEMP/authorize-headers.txt"

privacy_status="$(curl --silent --show-error --max-time 10 -o "$RUNNER_TEMP/privacy.html" -w '%{http_code}' "https://$TARGET_HOST/privacy" || true)"
[ "$privacy_status" = 200 ] || { echo "Privacy endpoint failed after relay readiness, HTTP $privacy_status." >&2; exit 1; }

token_guard_status="$(curl --silent --show-error --max-time 10 -o "$RUNNER_TEMP/token-guard.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' "https://$TARGET_HOST/oauth/token" || true)"
[ "$token_guard_status" = 415 ] || { echo "OAuth token content-type guard failed, HTTP $token_guard_status." >&2; exit 1; }

action_status="$(curl --silent --show-error --max-time 10 -o "$RUNNER_TEMP/action-disabled.json" -w '%{http_code}' "https://$TARGET_HOST/v1/appointments?from=2026-08-10T00%3A00%3A00Z&to=2026-08-11T00%3A00%3A00Z" || true)"
[ "$action_status" = 403 ] || { echo "WAF must block disabled appointment action paths, HTTP $action_status." >&2; exit 1; }

curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/workers/routes" > "$RUNNER_TEMP/routes-final.json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" > "$RUNNER_TEMP/domains-final.json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$RUNNER_TEMP/waf-final.json"
curl --fail --silent --show-error "${edge_auth[@]}" "https://api.cloudflare.com/client/v4/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "$RUNNER_TEMP/rate-final.json"
final_routes="$(jq --arg worker "$WORKER_NAME" '[.result[]? | select((.script // "") == $worker)] | length' "$RUNNER_TEMP/routes-final.json")"
final_domains="$(jq --arg host "$TARGET_HOST" --arg service "$WORKER_NAME" '[.result[]? | select(.hostname == $host and .service == $service)] | length' "$RUNNER_TEMP/domains-final.json")"
final_waf="$(jq --arg description "$WAF_DESCRIPTION" --arg expression "$WAF_EXPRESSION" '[.result.rules[]? | select(.description == $description and .expression == $expression and (.enabled // true) == true)] | length' "$RUNNER_TEMP/waf-final.json")"
final_rate_total="$(jq '[.result.rules[]?] | length' "$RUNNER_TEMP/rate-final.json")"
final_rate_target="$(jq --arg expression "$COMBINED_RATE_EXPRESSION" '[.result.rules[]? | select(.description == "staging-booking-rate-limit" and .expression == $expression and .ratelimit.period == 10 and .ratelimit.requests_per_period == 5 and .ratelimit.mitigation_timeout == 10)] | length' "$RUNNER_TEMP/rate-final.json")"
[ "$final_routes" = 0 ]
[ "$final_domains" = 1 ]
[ "$final_waf" = 1 ]
[ "$final_rate_total" = 1 ]
[ "$final_rate_target" = 1 ]

cat >> "$safe" <<EOF
oauth_relay_enabled=true
gpt_actions_enabled=false
post_worker_route_binding_count=$final_routes
post_target_custom_domain_count=$final_domains
post_target_waf_rule_count=$final_waf
post_rate_limit_total_rule_count=$final_rate_total
post_combined_shared_rate_rule_count=$final_rate_target
privacy_status=$privacy_status
authorize_status=$authorize_status
token_content_type_guard_status=$token_guard_status
disabled_action_waf_status=$action_status
cloudflare_mutated=true
production_targeted=false
EOF

complete=true
trap - EXIT
cat "$safe"
