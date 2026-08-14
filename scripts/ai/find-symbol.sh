#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/ai/find-symbol.sh <literal-symbol> [path ...]" >&2
  exit 2
fi

symbol="$1"
shift

paths=("$@")
if [[ ${#paths[@]} -eq 0 ]]; then
  paths=(.)
fi

if command -v rg >/dev/null 2>&1; then
  rg -n --hidden --fixed-strings \
    --glob '!.git/**' \
    --glob '!node_modules/**' \
    -- "$symbol" "${paths[@]}"
else
  if [[ ${#paths[@]} -eq 1 && "${paths[0]}" == "." ]]; then
    git grep -n -F -- "$symbol"
  else
    git grep -n -F -- "$symbol" -- "${paths[@]}"
  fi
fi
