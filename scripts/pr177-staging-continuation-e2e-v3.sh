#!/usr/bin/env bash
set -euo pipefail

bash scripts/pr177-staging-edge-e2e-v3.sh

readonly patched="${RUNNER_TEMP:?}/pr177-staging-continuation-data-e2e.sh"
readonly source_script="scripts/pr177-staging-continuation-e2e.sh"
readonly evidence_dir="${RUNNER_TEMP}/pr177-staging-evidence"
[ "$(grep -c '^  edge_assertions$' "$source_script")" -eq 1 ] \
  || { echo 'staging continuation wrapper failed: expected one edge_assertions call' >&2; exit 1; }
sed 's/^  edge_assertions$/  : # edge assertions completed by dedicated v3 harness/' \
  "$source_script" > "$patched"
chmod +x "$patched"
bash "$patched"

blockers="$(jq -c '.blockers // []' "$evidence_dir/edge-evidence.json")"
if [ "$(jq 'length' <<<"$blockers")" -gt 0 ]; then
  jq --argjson blockers "$blockers" \
    '.edge_security = "partial" | .remaining_blockers = $blockers' \
    "$evidence_dir/summary.json" > "$evidence_dir/summary.json.tmp"
else
  jq '.edge_security = "pass" | .remaining_blockers = []' \
    "$evidence_dir/summary.json" > "$evidence_dir/summary.json.tmp"
fi
mv "$evidence_dir/summary.json.tmp" "$evidence_dir/summary.json"
