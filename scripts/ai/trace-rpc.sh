#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: bash scripts/ai/trace-rpc.sh <rpc_name>" >&2
  exit 2
fi

rpc="$1"
search_roots=()
for path in workers admin supabase tests docs .github; do
  [[ -e "$path" ]] && search_roots+=("$path")
done

if [[ ${#search_roots[@]} -eq 0 ]]; then
  echo "error: expected repository paths were not found" >&2
  exit 3
fi

echo "== all exact occurrences: $rpc =="
if command -v rg >/dev/null 2>&1; then
  rg -n --hidden --fixed-strings --glob '!.git/**' -- "$rpc" "${search_roots[@]}" || true
else
  git grep -n -F -- "$rpc" -- "${search_roots[@]}" || true
fi

echo
echo "== likely SQL definition / ACL occurrences =="
if [[ -d supabase/migrations ]]; then
  if command -v rg >/dev/null 2>&1; then
    rg -n -i --fixed-strings -- "$rpc" supabase/migrations || true
    echo
    rg -n -i -- "(create( or replace)? function|drop function|grant execute|revoke all).*${rpc//./\\.}" supabase/migrations || true
  else
    git grep -n -F -- "$rpc" -- supabase/migrations || true
  fi
fi

echo
echo "== tests =="
test_roots=()
for path in tests supabase/tests; do
  [[ -e "$path" ]] && test_roots+=("$path")
done
if [[ ${#test_roots[@]} -gt 0 ]]; then
  if command -v rg >/dev/null 2>&1; then
    rg -n --fixed-strings -- "$rpc" "${test_roots[@]}" || true
  else
    git grep -n -F -- "$rpc" -- "${test_roots[@]}" || true
  fi
fi
