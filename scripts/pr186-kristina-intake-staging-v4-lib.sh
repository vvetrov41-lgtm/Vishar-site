#!/usr/bin/env bash
set -euo pipefail

: "${APPROVED_SHA:?}"
: "${PROJECT_REF:?}"
: "${WORKER_NAME:?}"
: "${WORKER_URL:?}"
: "${VLADIMIR_ORIGIN:?}"
: "${KRISTINA_ORIGIN:?}"
: "${VLADIMIR_ID:?}"
: "${KRISTINA_ID:?}"
: "${SUPABASE_ACCESS_TOKEN:?}"
: "${STAGING_SUPABASE_URL:?}"
: "${CLOUDFLARE_API_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"
: "${RUNNER_TEMP:?}"

CF_API='https://api.cloudflare.com/client/v4'
CF_AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
EVIDENCE_DIR="$RUNNER_TEMP/pr186-v4-evidence"
CONFIG="$RUNNER_TEMP/wrangler.pr186-v4.toml"
export CONFIG
mkdir -p "$EVIDENCE_DIR"

metadata_changed=false
worker_maybe_changed=false
previous_version=''
new_version=''
zone_id=''
access_hash_before=''
waf_hash_before=''
rate_hash_before=''

sql_query() {
  local sql_file="$1"
  local out_file="$2"
  local request_file raw_file
  request_file="${out_file%.json}-request.json"
  raw_file="${out_file%.json}-raw.json"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" > "$raw_file"
  jq -e 'if type == "array" then true else ((.error // null) == null and (.result // null) != null) end' "$raw_file" >/dev/null
  jq 'if type == "array" then . else .result end' "$raw_file" > "$out_file"
}

active_worker_version() {
  local out="$1"
  curl --fail-with-body --silent --show-error "${CF_AUTH[@]}" \
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/deployments" > "$out"
  jq -e '.success == true' "$out" >/dev/null
  jq -r '(.result.deployments // .result)[0].versions[]? | select(.percentage == 100) | .version_id' "$out" | head -n1
}

canonical_hash() {
  local file="$1"
  local filter="$2"
  jq -Sc "$filter" "$file" | sha256sum | awk '{print $1}'
}

read_control_plane() {
  local label="$1"
  local access_file="$RUNNER_TEMP/access-${label}.json"
  local waf_file="$RUNNER_TEMP/waf-${label}.json"
  local rate_file="$RUNNER_TEMP/rate-${label}.json"
  local subdomain_file="$RUNNER_TEMP/subdomain-${label}.json"
  local zone_file="$RUNNER_TEMP/zone-${label}.json"
  local access_hash waf_hash rate_hash waf_enabled rate_enabled

  curl --fail-with-body --silent --show-error "${CF_AUTH[@]}" \
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps?per_page=200" > "$access_file"
  jq -e '.success == true and (.result | type == "array")' "$access_file" >/dev/null
  access_hash="$(canonical_hash "$access_file" '.result | sort_by(.id)')"

  curl --fail-with-body --silent --show-error "${CF_AUTH[@]}" \
    "$CF_API/zones?name=vishartattoo.com" > "$zone_file"
  jq -e '.success == true and (.result | length == 1)' "$zone_file" >/dev/null
  zone_id="$(jq -r '.result[0].id' "$zone_file")"
  [ -n "$zone_id" ]

  curl --fail-with-body --silent --show-error "${CF_AUTH[@]}" \
    "$CF_API/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" > "$waf_file"
  jq -e '.success == true' "$waf_file" >/dev/null
  waf_enabled="$(jq '[.result.rules[]? | select(.enabled == true)] | length' "$waf_file")"
  [ "$waf_enabled" -gt 0 ] || {
    echo 'No enabled custom WAF rules are present on the staging zone.' >&2
    return 1
  }
  waf_hash="$(canonical_hash "$waf_file" '(.result.rules // []) | sort_by(.id)')"

  curl --fail-with-body --silent --show-error "${CF_AUTH[@]}" \
    "$CF_API/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" > "$rate_file"
  jq -e '.success == true' "$rate_file" >/dev/null
  rate_enabled="$(jq '[.result.rules[]? | select(.enabled == true)] | length' "$rate_file")"
  [ "$rate_enabled" -gt 0 ] || {
    echo 'No enabled rate-limit rules are present on the staging zone.' >&2
    return 1
  }
  rate_hash="$(canonical_hash "$rate_file" '(.result.rules // []) | sort_by(.id)')"

  curl --fail-with-body --silent --show-error "${CF_AUTH[@]}" \
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" > "$subdomain_file"
  jq -e '.success == true and .result.enabled == false and .result.previews_enabled == false' "$subdomain_file" >/dev/null

  if [ "$label" = before ]; then
    access_hash_before="$access_hash"
    waf_hash_before="$waf_hash"
    rate_hash_before="$rate_hash"
  else
    [ "$access_hash" = "$access_hash_before" ] || {
      echo 'Cloudflare Access application configuration changed during staging deploy.' >&2
      return 1
    }
    [ "$waf_hash" = "$waf_hash_before" ] || {
      echo 'Cloudflare WAF configuration changed during staging deploy.' >&2
      return 1
    }
    [ "$rate_hash" = "$rate_hash_before" ] || {
      echo 'Cloudflare rate-limit configuration changed during staging deploy.' >&2
      return 1
    }
  fi

  jq -n \
    --arg label "$label" \
    --arg access_hash "$access_hash" \
    --arg waf_hash "$waf_hash" \
    --arg rate_hash "$rate_hash" \
    --argjson access_apps "$(jq '.result | length' "$access_file")" \
    --argjson waf_enabled "$waf_enabled" \
    --argjson rate_enabled "$rate_enabled" \
    '{label:$label, access_apps:$access_apps, access_hash:$access_hash, waf_enabled:$waf_enabled, waf_hash:$waf_hash, rate_enabled:$rate_enabled, rate_hash:$rate_hash, workers_dev:false, previews_enabled:false}' \
    > "$EVIDENCE_DIR/control-plane-${label}.json"
}

live_edge_check() {
  local label="$1"
  local require_kristina="$2"
  local code observed_429=false

  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    -X OPTIONS -H "Origin: $VLADIMIR_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 204 ] || {
    echo "Vladimir trusted preflight failed during $label check with HTTP $code." >&2
    return 1
  }

  if [ "$require_kristina" = true ]; then
    code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      -X OPTIONS -H "Origin: $KRISTINA_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
    [ "$code" = 204 ] || {
      echo "Kristina trusted preflight failed during $label check with HTTP $code." >&2
      return 1
    }
  fi

  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 403 ] || {
    echo "Wrong Origin was not rejected during $label check, HTTP $code." >&2
    return 1
  }

  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    -X GET -H "Origin: $VLADIMIR_ORIGIN" "$WORKER_URL")"
  [ "$code" = 403 ] || {
    echo "WAF did not block GET on exact intake path during $label check, HTTP $code." >&2
    return 1
  }

  for method in OPTIONS POST; do
    code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      -X "$method" -H "Origin: $VLADIMIR_ORIGIN" \
      -H 'Access-Control-Request-Method: POST' \
      'https://intake-staging.vishartattoo.com/__vishar-staging-intake-2026-wrong')"
    [ "$code" = 403 ] || {
      echo "WAF did not block wrong intake path for $method during $label check, HTTP $code." >&2
      return 1
    }
  done

  sleep 12
  for _ in 1 2 3 4 5 6 7; do
    code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      -X OPTIONS -H "Origin: $VLADIMIR_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
    if [ "$code" = 429 ]; then
      observed_429=true
      break
    fi
  done
  [ "$observed_429" = true ] || {
    echo "Rate limit did not produce HTTP 429 during $label check." >&2
    return 1
  }

  sleep 12
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    -X OPTIONS -H "Origin: $VLADIMIR_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 204 ] || {
    echo "Rate limit did not recover during $label check, HTTP $code." >&2
    return 1
  }

  jq -n --arg label "$label" --argjson kristina_checked "$require_kristina" \
    '{label:$label, vladimir_preflight:true, kristina_preflight:$kristina_checked, wrong_origin_rejected:true, waf_exact_method_blocked:true, waf_wrong_path_blocked:true, rate_limit_429:true, rate_limit_recovered:true}' \
    > "$EVIDENCE_DIR/live-edge-${label}.json"
}

verify_db_rollback_state() {
  local sql_file="$RUNNER_TEMP/rollback-verify.sql"
  local rows_file="$RUNNER_TEMP/rollback-verify-rows.json"
  cat > "$sql_file" <<SQL
select source_key, artist_id, allowed_origin, form_version, is_active
from public.booking_sources
where source_key in ('vladimir-staging','kristina-website')
order by source_key;
SQL
  sql_query "$sql_file" "$rows_file"
  jq -e --arg vladimir "$VLADIMIR_ID" --arg vorig "$VLADIMIR_ORIGIN" --arg kristina "$KRISTINA_ID" '
    length == 2
    and any(.[]; .source_key == "vladimir-staging" and .artist_id == $vladimir and .allowed_origin == $vorig and .form_version == "booking-v1" and .is_active == true)
    and any(.[]; .source_key == "kristina-website" and .artist_id == $kristina and .allowed_origin == null and .form_version == "booking-v1" and .is_active == false)
  ' "$rows_file" >/dev/null
}

rollback_on_failure() {
  local status="$?"
  if [ "$status" -eq 0 ]; then
    return 0
  fi

  set +e
  local worker_rolled_back=false source_rolled_back=false current_version=''

  if [ "$worker_maybe_changed" = true ] && [ -n "$previous_version" ] && [ -n "$new_version" ]; then
    current_version="$(active_worker_version "$RUNNER_TEMP/deployments-failure.json" 2>/dev/null)"
    if [ "$current_version" = "$new_version" ] && [ "$current_version" != "$previous_version" ]; then
      if npx wrangler rollback "$previous_version" \
        --config "$CONFIG" \
        --env preview \
        --message 'Rollback failed PR186 Kristina staging validation' >/dev/null 2>&1; then
        worker_rolled_back=true
      fi
    elif [ -n "$current_version" ] && [ "$current_version" != "$previous_version" ]; then
      echo 'Active Worker version changed to an unrecognized version; refusing to overwrite it during rollback.' >&2
    fi
  fi

  if [ "$metadata_changed" = true ]; then
    cat > "$RUNNER_TEMP/rollback-source.sql" <<SQL
update public.booking_sources
set allowed_origin=null, form_version='booking-v1', is_active=false
where source_key='kristina-website' and artist_id='$KRISTINA_ID';
SQL
    if sql_query "$RUNNER_TEMP/rollback-source.sql" "$RUNNER_TEMP/rollback-source-rows.json"; then
      source_rolled_back=true
    fi
  fi

  sleep 3
  local vladimir_code
  vladimir_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    -X OPTIONS -H "Origin: $VLADIMIR_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL" 2>/dev/null)"
  verify_db_rollback_state >/dev/null 2>&1
  local db_ok=$?

  jq -n \
    --argjson worker_rolled_back "$worker_rolled_back" \
    --argjson source_rolled_back "$source_rolled_back" \
    --arg vladimir_http "$vladimir_code" \
    --argjson db_restored "$([ "$db_ok" -eq 0 ] && echo true || echo false)" \
    '{worker_rolled_back:$worker_rolled_back, source_rolled_back:$source_rolled_back, vladimir_preflight_http:$vladimir_http, db_restored:$db_restored}' \
    > "$EVIDENCE_DIR/rollback.json"

  if [ "$vladimir_code" != 204 ] || [ "$db_ok" -ne 0 ]; then
    echo 'Rollback verification did not restore the expected fail-closed staging state.' >&2
  fi
  exit "$status"
}
trap rollback_on_failure EXIT
