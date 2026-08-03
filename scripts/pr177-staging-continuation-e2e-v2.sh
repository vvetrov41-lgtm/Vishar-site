#!/usr/bin/env bash
set -euo pipefail

# Run the dedicated edge harness first. It completes public HTTP, WAF,
# rate-limit and workers.dev checks even when the deployment token cannot read
# Access applications and policies; that permission gap remains explicit.
bash scripts/pr177-staging-edge-e2e.sh

# The original continuation harness contains the earlier edge function.
# Execute a temporary copy with that single call replaced because the dedicated
# edge harness above has already produced edge-evidence.json.
readonly patched="${RUNNER_TEMP:?}/pr177-staging-continuation-data-e2e.sh"
readonly source_script="scripts/pr177-staging-continuation-e2e.sh"
readonly evidence_dir="${RUNNER_TEMP}/pr177-staging-evidence"
[ "$(grep -c '^  edge_assertions$' "$source_script")" -eq 1 ] \
  || { echo 'staging continuation wrapper failed: expected one edge_assertions call' >&2; exit 1; }
sed 's/^  edge_assertions$/  : # edge assertions completed by dedicated harness/' \
  "$source_script" > "$patched"
chmod +x "$patched"
bash "$patched"

# Do not label edge security as fully passed when Cloudflare Access policy
# contents could not be read. Preserve the completed controls and one blocker.
if jq -e '.access_policy_blocker != null' "$evidence_dir/edge-evidence.json" >/dev/null; then
  jq '
    .edge_security = "partial"
    | .remaining_blockers = ["Cloudflare deployment token lacks Access: Apps and Policies Read; owner-only policy contents were not independently re-read"]
  ' "$evidence_dir/summary.json" > "$evidence_dir/summary.json.tmp"
else
  jq '.edge_security = "pass" | .remaining_blockers = []' \
    "$evidence_dir/summary.json" > "$evidence_dir/summary.json.tmp"
fi
mv "$evidence_dir/summary.json.tmp" "$evidence_dir/summary.json"
