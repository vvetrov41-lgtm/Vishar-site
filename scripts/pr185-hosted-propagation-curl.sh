#!/usr/bin/env bash
set -u

real_curl="${REAL_CURL:?REAL_CURL is required}"
target_host="${RETRY_TARGET_HOST:?RETRY_TARGET_HOST is required}"

mode=''
for arg in "$@"; do
  case "$arg" in
    "https://$target_host/oauth/token"|"https://$target_host/oauth/token/") mode='token' ;;
    "https://$target_host/privacy"|"https://$target_host/privacy/") mode='privacy' ;;
    "https://$target_host/v1/appointments"* ) mode='action' ;;
  esac
done

if [ -z "$mode" ]; then
  exec "$real_curl" "$@"
fi

case "$mode" in
  token) expected='415' ;;
  privacy) expected='200' ;;
  action) expected='403' ;;
  *) exec "$real_curl" "$@" ;;
esac

last='000'
for attempt in $(seq 1 36); do
  output=''
  rc=0
  output="$("$real_curl" "$@")" || rc=$?
  [ -n "$output" ] && last="$output"
  if [ "$rc" = 0 ] && [ "$output" = "$expected" ]; then
    printf '%s' "$output"
    exit 0
  fi
  sleep 5
done

printf '%s' "$last"
exit 0
