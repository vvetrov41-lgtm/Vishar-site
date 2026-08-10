#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: bash scripts/ai/migration-history.sh <literal-symbol>" >&2
  exit 2
fi

symbol="$1"

if [[ ! -d supabase/migrations ]]; then
  echo "error: supabase/migrations not found" >&2
  exit 3
fi

echo "== ordered migration occurrences: $symbol =="
if command -v rg >/dev/null 2>&1; then
  rg -n -i --fixed-strings -- "$symbol" supabase/migrations || true
else
  git grep -n -F -- "$symbol" -- supabase/migrations || true
fi

echo
echo "== commits that add/remove the literal symbol in migrations =="
git log --oneline --decorate -S"$symbol" -- supabase/migrations || true

echo
echo "== current migration files containing the symbol =="
if command -v rg >/dev/null 2>&1; then
  rg -l -i --fixed-strings -- "$symbol" supabase/migrations | sort || true
else
  git grep -l -F -- "$symbol" -- supabase/migrations | sort || true
fi
