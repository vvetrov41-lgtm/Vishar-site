#!/usr/bin/env bash
set -euo pipefail

# Run edge controls first. This prevents creating another synthetic intake when
# the independent Cloudflare control-plane check is unavailable.
bash scripts/pr177-staging-edge-e2e.sh

# The original continuation harness already contains the same edge function.
# Execute a temporary copy with that single call replaced because the dedicated
# edge script above has completed it with account/zone Access API fallback.
readonly patched="${RUNNER_TEMP:?}/pr177-staging-continuation-data-e2e.sh"
readonly source_script="scripts/pr177-staging-continuation-e2e.sh"
[ "$(grep -c '^  edge_assertions$' "$source_script")" -eq 1 ] \
  || { echo 'staging continuation wrapper failed: expected one edge_assertions call' >&2; exit 1; }
sed 's/^  edge_assertions$/  : # edge assertions completed by dedicated harness/' \
  "$source_script" > "$patched"
chmod +x "$patched"
bash "$patched"
