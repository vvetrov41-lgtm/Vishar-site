#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?}"
: "${CLOUDFLARE_EDGE_READ_TOKEN:?}"
: "${RUNNER_TEMP:?}"
: "${GITHUB_WORKSPACE:?}"

# V4 already contains the mutation, rollback and E2E logic. V5 patches only a
# temporary validation copy so Cloudflare control-plane reads use the dedicated
# read token while Worker deployment/version reads keep the deployment token.
work_dir="$RUNNER_TEMP/pr186-v5-runtime"
rm -rf "$work_dir"
mkdir -p "$work_dir"
cp scripts/pr186-kristina-intake-staging-v4-lib.sh "$work_dir/pr186-kristina-intake-staging-v4-lib.sh"
cp scripts/pr186-kristina-intake-staging-v4.sh "$work_dir/pr186-kristina-intake-staging-v4.sh"

python3 - <<'PY'
from pathlib import Path
import os

work = Path(os.environ['RUNNER_TEMP']) / 'pr186-v5-runtime'
lib = work / 'pr186-kristina-intake-staging-v4-lib.sh'
text = lib.read_text(encoding='utf-8')

needle = ': "${CLOUDFLARE_API_TOKEN:?}"\n: "${CLOUDFLARE_ACCOUNT_ID:?}"'
replacement = ': "${CLOUDFLARE_API_TOKEN:?}"\n: "${CLOUDFLARE_EDGE_READ_TOKEN:?}"\n: "${CLOUDFLARE_ACCOUNT_ID:?}"'
if text.count(needle) != 1:
    raise SystemExit('unexpected V4 Cloudflare env guard shape')
text = text.replace(needle, replacement)

needle = "CF_AUTH=(-H \"Authorization: Bearer $CLOUDFLARE_API_TOKEN\" -H 'Content-Type: application/json')"
replacement = needle + "\nCF_EDGE_AUTH=(-H \"Authorization: Bearer $CLOUDFLARE_EDGE_READ_TOKEN\" -H 'Content-Type: application/json')"
if text.count(needle) != 1:
    raise SystemExit('unexpected V4 Cloudflare auth shape')
text = text.replace(needle, replacement)

# Wrangler resolves a relative `main` from the config file directory. Keep the
# temporary config in the repository root so `workers/preview.js` resolves to
# the exact checked-out file rather than under RUNNER_TEMP.
needle = 'CONFIG="$RUNNER_TEMP/wrangler.pr186-v4.toml"'
replacement = 'CONFIG="$GITHUB_WORKSPACE/wrangler.pr186-v5.toml"'
if text.count(needle) != 1:
    raise SystemExit('unexpected V4 Wrangler config path shape')
text = text.replace(needle, replacement)

start = text.index('read_control_plane() {')
end = text.index('\nlive_edge_check() {', start)
block = text[start:end]

# Access, zone, WAF and rate-limit are read with the dedicated read token.
if block.count('"${CF_AUTH[@]}"') != 5:
    raise SystemExit('unexpected V4 control-plane curl count')
block = block.replace('"${CF_AUTH[@]}"', '"${CF_EDGE_AUTH[@]}"')

# Worker subdomain state is read with the deploy token and the service endpoint
# already proven by the retained-staging PR177 validation.
old = '''  curl --fail-with-body --silent --show-error "${CF_EDGE_AUTH[@]}" \\
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" > "$subdomain_file"'''
new = '''  curl --fail-with-body --silent --show-error "${CF_AUTH[@]}" \\
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/$WORKER_NAME/environments/production/subdomain" > "$subdomain_file"'''
if block.count(old) != 1:
    raise SystemExit('unexpected V4 Worker subdomain read shape')
block = block.replace(old, new)

if block.count('"${CF_EDGE_AUTH[@]}"') != 4 or block.count('"${CF_AUTH[@]}"') != 1:
    raise SystemExit('V5 token separation assertion failed')

text = text[:start] + block + text[end:]
lib.write_text(text, encoding='utf-8')
PY

bash -n "$work_dir/pr186-kristina-intake-staging-v4-lib.sh"
bash -n "$work_dir/pr186-kristina-intake-staging-v4.sh"

# Running the copied main script makes its dirname resolve to the copied,
# token-separated library above. The Wrangler config itself remains at the
# repository root so relative module paths stay exact.
bash "$work_dir/pr186-kristina-intake-staging-v4.sh"
