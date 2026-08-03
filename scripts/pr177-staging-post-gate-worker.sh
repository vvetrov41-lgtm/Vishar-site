#!/usr/bin/env bash
set -euo pipefail

# Idempotent staging-only Worker configuration and deployment for PR #177.
# Secret values are written only through Wrangler encrypted bindings and never printed.

readonly BOOKING_ORIGIN="https://vishar-booking-staging.pages.dev"
readonly SOURCE_KEY="vladimir-staging"
readonly FORM_VERSION="booking-v1"
readonly ROUTE_BINDING="ARTIST_TELEGRAM_VLADIMIR_HSTAGING"

evidence_dir="${RUNNER_TEMP:?}/pr177-staging-evidence"
mkdir -p "$evidence_dir"

require_env() {
  [ -n "${!1:-}" ] || {
    echo "required encrypted secret $1 is unavailable" >&2
    exit 1
  }
}

for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID SUPABASE_SECRET_KEY \
  TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID STAGING_SUPABASE_URL; do
  require_env "$name"
done

cp wrangler.toml wrangler.preview.toml
python3 - <<'PY'
from pathlib import Path
p = Path('wrangler.preview.toml')
s = p.read_text()
old = 'main = "workers/tattooai.js"'
new = 'main = "workers/preview.js"'
if s.count(old) != 1:
    raise SystemExit('expected exactly one Worker entrypoint')
p.write_text(s.replace(old, new))
PY

secret_file="$(mktemp "${RUNNER_TEMP}/pr177-worker-secrets.XXXXXX.json")"
chmod 600 "$secret_file"
jq -n \
  --arg service "$SUPABASE_SECRET_KEY" \
  --arg bot "$TELEGRAM_BOT_TOKEN" \
  --arg chat "$TELEGRAM_CHAT_ID" \
  --arg binding "$ROUTE_BINDING" \
  '{SUPABASE_SECRET_KEY:$service,TELEGRAM_BOT_TOKEN:null,TELEGRAM_CHAT_ID:null}
   + {($binding):({botToken:$bot,chatId:$chat}|tojson)}' > "$secret_file"

npx wrangler secret bulk --config wrangler.preview.toml --env preview < "$secret_file"
rm -f "$secret_file"

# Wrangler 4 uses --format json; JSON is also the default. The deprecated
# --json flag is intentionally not used.
npx wrangler secret list \
  --config wrangler.preview.toml \
  --env preview \
  --format json > "${evidence_dir}/worker-bindings.json"

jq -e --arg required "$ROUTE_BINDING" '
  [ .[]?.name ] as $names
  | ($names | index($required)) != null
  and ($names | index("SUPABASE_SECRET_KEY")) != null
  and ($names | index("TELEGRAM_BOT_TOKEN")) == null
  and ($names | index("TELEGRAM_CHAT_ID")) == null
' "${evidence_dir}/worker-bindings.json" >/dev/null

npx wrangler deploy \
  --config wrangler.preview.toml \
  --env preview \
  --var VISHAR_ENVIRONMENT:preview \
  --var SUPABASE_URL:"$STAGING_SUPABASE_URL" \
  --var ALLOWED_ORIGINS:"$BOOKING_ORIGIN" \
  --var BOOKING_SOURCE_KEY:"$SOURCE_KEY" \
  --var BOOKING_FORM_VERSION:"$FORM_VERSION" \
  2>&1 | tee "${evidence_dir}/worker-deploy.txt"

npx wrangler deployments list \
  --config wrangler.preview.toml \
  --env preview \
  --json > "${evidence_dir}/worker-deployments.json"

jq -e 'length > 0 and (.[0].id | type == "string")' \
  "${evidence_dir}/worker-deployments.json" >/dev/null
