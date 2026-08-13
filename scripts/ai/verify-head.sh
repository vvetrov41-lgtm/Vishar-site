#!/usr/bin/env bash
set -euo pipefail

expected_sha="${1:-}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git work tree" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
head_sha="$(git rev-parse HEAD)"
branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  branch="(detached)"
fi

echo "repository_root: $root"
echo "branch: $branch"
echo "head_sha: $head_sha"

if [[ -n "$expected_sha" ]]; then
  expected_full="$(git rev-parse "$expected_sha^{commit}" 2>/dev/null || true)"
  if [[ -z "$expected_full" ]]; then
    echo "expected_sha: $expected_sha"
    echo "match: no (expected ref cannot be resolved locally)" >&2
    exit 3
  fi
  echo "expected_sha: $expected_full"
  if [[ "$head_sha" != "$expected_full" ]]; then
    echo "match: no" >&2
    exit 1
  fi
  echo "match: yes"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working_tree: dirty"
  git status --short
else
  echo "working_tree: clean"
fi
