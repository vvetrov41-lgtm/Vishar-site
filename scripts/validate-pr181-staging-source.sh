#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "PR181 staging source validation failed: $*" >&2
  exit 1
}

bash -n scripts/pr181-staging-calendar-connections.sh

mapfile -t migration_files < <(
  find supabase/migrations -maxdepth 1 -type f -printf '%f\n' | sort
)
[ "${#migration_files[@]}" -eq 30 ] \
  || fail "expected exactly 30 local migrations, found ${#migration_files[@]}"

for number in $(seq 1 30); do
  printf -v version '%04d' "$number"
  matches="$(printf '%s\n' "${migration_files[@]}" | grep -Ec "^${version}_[a-z0-9_]+\.sql$")"
  [ "$matches" -eq 1 ] || fail "expected exactly one local migration ${version}"
done

if printf '%s\n' "${migration_files[@]}" | grep -Eq '^00(3[1-9]|[4-9][0-9])_'; then
  fail "a local migration after 0030 is outside the guarded PR181 workflow"
fi

grep -Fxq '0029_calendar_outbox_drain.sql' <(
  printf '%s\n' "${migration_files[@]}"
)
grep -Fxq '0030_calendar_connection_status.sql' <(
  printf '%s\n' "${migration_files[@]}"
)

grep -Fq "case '/integrations/calendar':" admin/src/App.tsx
grep -Fq "path: '/integrations'" admin/src/lib/permissions.ts
grep -Fq 'list_calendar_connection_status' admin/src/lib/calendar-connections-api.ts
grep -Fq 'https://calendar-staging.vishartattoo.com' admin/src/pages/CalendarConnectionsPage.tsx
grep -Fq 'env.SUPABASE_SERVICE_ROLE_KEY' admin/src/lib/supabase.ts
grep -Fq 'supabase_secret_value|sb_secret_[A-Za-z0-9_-]{20,}' scripts/pr181-staging-calendar-connections.sh
! grep -Fq 'legacy_supabase_secret_name|SUPABASE_SERVICE_ROLE_KEY' scripts/pr181-staging-calendar-connections.sh
grep -Fxq 'CRM_RETURN_URL = "https://vishar-crm-staging.pages.dev/#/integrations/calendar"' wrangler.calendar.staging.toml
grep -Fxq 'CRM_APPOINTMENTS_URL = "https://vishar-crm-staging.pages.dev/#/appointments"' wrangler.calendar.staging.toml
grep -Fxq 'CALENDAR_DRAIN_ENABLED = "false"' wrangler.calendar.staging.toml

! grep -Eq '^\[triggers\]$|^crons\s*=' wrangler.calendar.staging.toml
! grep -R -E -q \
  '<!-- RUN_PR181_CALENDAR_CONNECTIONS_STAGING -->' \
  --exclude='pr181-calendar-connections-staging.yml' \
  --exclude='validate-pr181-staging-source.sh' \
  .

printf '%s\n' 'PR181 staging source validation passed.'
