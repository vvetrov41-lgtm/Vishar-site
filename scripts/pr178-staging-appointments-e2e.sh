#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly CRM_ORIGIN="https://vishar-crm-staging.pages.dev"
readonly VLADIMIR_ID="a1111111-1111-4111-8111-111111111111"

evidence_dir="${RUNNER_TEMP:?}/pr178-staging-evidence"
mkdir -p "$evidence_dir"

die() { echo "PR178 staging validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted secret $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr178-sql.XXXXXX.json")"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" > "$output_file"
  rm -f "$request_file"
  jq -e 'if type == "array" then true else ((.error // null) == null and (.result // null) != null) end' \
    "$output_file" >/dev/null || die "hosted SQL request failed"
}

rows() {
  jq -c 'if type == "array" then . else .result end' "$1"
}

migration_versions() {
  awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9][0-9][0-9][0-9]$/) print $2}' "$1"
}

verify_contiguous_migrations() {
  local file="$1" expected="$2"
  mapfile -t versions < <(migration_versions "$file")
  [ "${#versions[@]}" -eq "$expected" ] || die "expected $expected linked migrations, found ${#versions[@]}"
  for n in $(seq -w 1 "$expected"); do
    printf '%s\n' "${versions[@]}" | grep -Fxq "00$n" || die "remote migration 00$n is absent"
  done
}

snapshot() {
  local output="$1"
  cat > "${RUNNER_TEMP}/pr178-snapshot.sql" <<'SQL'
select jsonb_build_object(
  'clients', (select count(*) from public.clients),
  'enquiries', (select count(*) from public.enquiries),
  'projects', (select count(*) from public.projects),
  'sessions', (select count(*) from public.sessions),
  'outbox', (select count(*) from public.integration_outbox),
  'activity', (select count(*) from public.activity_log)
) as snapshot;
SQL
  sql "${RUNNER_TEMP}/pr178-snapshot.sql" "$output"
}

migrate_and_validate() {
  require_env SUPABASE_ACCESS_TOKEN
  require_env SUPABASE_DB_PASSWORD

  npx supabase@2.111.0 link --project-ref "$PROJECT_REF"
  npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-before.txt"

  mapfile -t before_versions < <(migration_versions "${evidence_dir}/migrations-before.txt")
  case "${#before_versions[@]}" in
    25)
      verify_contiguous_migrations "${evidence_dir}/migrations-before.txt" 25
      ;;
    26)
      verify_contiguous_migrations "${evidence_dir}/migrations-before.txt" 26
      ;;
    *)
      die "retained staging must contain exactly migrations 0001-0025 or the idempotent resume state 0001-0026"
      ;;
  esac

  snapshot "${evidence_dir}/database-before.json"

  if [ "${#before_versions[@]}" -eq 25 ]; then
    npx supabase@2.111.0 db push --linked --dry-run 2>&1 | tee "${evidence_dir}/migration-dry-run.txt"
    grep -Fq '0026_appointment_types.sql' "${evidence_dir}/migration-dry-run.txt" \
      || die "dry-run omitted migration 0026"
    if grep -Eq '00(2[7-9]|[3-9][0-9])_' "${evidence_dir}/migration-dry-run.txt"; then
      die "dry-run included an unexpected migration after 0026"
    fi
    npx supabase@2.111.0 db push --linked --yes
  fi

  npx supabase@2.111.0 migration list --linked > "${evidence_dir}/migrations-after.txt"
  verify_contiguous_migrations "${evidence_dir}/migrations-after.txt" 26

  npx supabase@2.111.0 test db --linked 2>&1 | tee "${evidence_dir}/hosted-pgtap.txt"
  grep -Eq 'Tests=960|Tests[=:][[:space:]]*960|1\.\.960' "${evidence_dir}/hosted-pgtap.txt" \
    || die "hosted pgTAP count was not exactly 960"
  grep -Eq 'Result:[[:space:]]*PASS|All tests successful' "${evidence_dir}/hosted-pgtap.txt" \
    || die "hosted pgTAP did not pass"

  npx supabase@2.111.0 db lint --linked --schema public,crm_private --level error --fail-on error \
    2>&1 | tee "${evidence_dir}/hosted-lint.txt"

  snapshot "${evidence_dir}/database-after.json"
  before_snapshot="$(rows "${evidence_dir}/database-before.json" | jq -c '.[0].snapshot')"
  after_snapshot="$(rows "${evidence_dir}/database-after.json" | jq -c '.[0].snapshot')"
  [ "$before_snapshot" = "$after_snapshot" ] || die "migration 0026 changed retained row counts"

  cat > "${RUNNER_TEMP}/pr178-schema-check.sql" <<'SQL'
select jsonb_build_object(
  'appointment_type_column',
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='sessions' and column_name='appointment_type'
    ),
  'client_id_column',
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='sessions' and column_name='client_id'
    ),
  'enquiry_id_column',
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='sessions' and column_name='enquiry_id'
    ),
  'null_client_rows', (select count(*) from public.sessions where client_id is null),
  'legacy_non_tattoo_rows', (
    select count(*) from public.sessions
    where project_id is not null and appointment_type <> 'tattoo_session'
  )
) as schema_check;
SQL
  sql "${RUNNER_TEMP}/pr178-schema-check.sql" "${evidence_dir}/schema-check.json"
  rows "${evidence_dir}/schema-check.json" | jq -e '
    .[0].schema_check.appointment_type_column == true
    and .[0].schema_check.client_id_column == true
    and .[0].schema_check.enquiry_id_column == true
    and .[0].schema_check.null_client_rows == 0
    and .[0].schema_check.legacy_non_tattoo_rows == 0
  ' >/dev/null || die "appointment schema or backfill verification failed"
}

run_hosted_appointment_e2e() {
  cat > "${RUNNER_TEMP}/pr178-appointments-e2e.sql" <<SQL
begin;

create temporary table pr178_e2e_ids (
  appointment_type public.appointment_type primary key,
  appointment_id uuid not null
);
grant select, insert on pr178_e2e_ids to authenticated, service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (
      select profile_id
      from crm_private.profile_access
      where role = 'owner' and is_active
      order by profile_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);

set local role authenticated;

do \$e2e\$
declare
  v_artist constant uuid := '${VLADIMIR_ID}'::uuid;
  v_project uuid;
  v_project_client uuid;
  v_project_enquiry uuid;
  v_consult_client uuid;
  v_consult_enquiry uuid;
  v_start timestamptz := date_trunc('day', now()) + interval '400 days 10 hours';
  v_result jsonb;
  v_id uuid;
  v_conflicts integer;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'active owner context is required for hosted appointment E2E';
  end if;

  select p.id, p.client_id, p.enquiry_id
    into v_project, v_project_client, v_project_enquiry
  from public.projects p
  join public.clients c on c.id = p.client_id
  where p.artist_id = v_artist
    and p.archived_at is null
    and c.email ~* '@example\\.(invalid|com)$'
  order by p.created_at, p.id
  limit 1;

  if v_project is null then
    raise exception 'synthetic Vladimir project is required for hosted appointment E2E';
  end if;

  select e.client_id, e.id
    into v_consult_client, v_consult_enquiry
  from public.enquiries e
  join public.clients c on c.id = e.client_id
  where e.artist_id = v_artist
    and e.archived_at is null
    and c.email ~* '@example\\.(invalid|com)$'
  order by e.created_at, e.id
  limit 1;

  if v_consult_enquiry is null then
    raise exception 'synthetic Vladimir enquiry is required for hosted appointment E2E';
  end if;

  v_result := public.schedule_appointment(
    v_artist, v_project_client, 'tattoo_session',
    v_start, v_start + interval '7 hours', 'proposed',
    v_project_enquiry, v_project, 'PR178 synthetic tattoo session'
  );
  v_id := (v_result ->> 'appointment_id')::uuid;
  insert into pr178_e2e_ids values ('tattoo_session', v_id);

  v_result := public.schedule_appointment(
    v_artist, v_consult_client, 'in_person_consultation',
    v_start + interval '15 minutes', v_start + interval '1 hour', 'proposed',
    v_consult_enquiry, null, 'PR178 synthetic in-person consultation'
  );
  v_id := (v_result ->> 'appointment_id')::uuid;
  insert into pr178_e2e_ids values ('in_person_consultation', v_id);

  v_result := public.schedule_appointment(
    v_artist, v_consult_client, 'video_consultation',
    v_start + interval '20 minutes', v_start + interval '50 minutes', 'proposed',
    v_consult_enquiry, null, 'PR178 synthetic video consultation'
  );
  v_id := (v_result ->> 'appointment_id')::uuid;
  insert into pr178_e2e_ids values ('video_consultation', v_id);

  v_result := public.schedule_appointment(
    v_artist, v_project_client, 'touch_up',
    v_start + interval '30 minutes', v_start + interval '2 hours 30 minutes', 'proposed',
    v_project_enquiry, v_project, 'PR178 synthetic touch-up'
  );
  v_id := (v_result ->> 'appointment_id')::uuid;
  insert into pr178_e2e_ids values ('touch_up', v_id);

  select count(*) into v_conflicts
  from public.list_appointment_conflicts(
    v_artist,
    v_start + interval '35 minutes',
    v_start + interval '40 minutes',
    null
  ) c
  join pr178_e2e_ids i on i.appointment_id = c.appointment_id;

  if v_conflicts <> 4 then
    raise exception 'expected four cross-type appointment conflicts, found %', v_conflicts;
  end if;

  perform public.set_appointment_status(
    (select appointment_id from pr178_e2e_ids where appointment_type='video_consultation'),
    'confirmed'
  );
  perform public.set_appointment_status(
    (select appointment_id from pr178_e2e_ids where appointment_type='video_consultation'),
    'completed'
  );

  perform public.set_appointment_status(
    (select appointment_id from pr178_e2e_ids where appointment_type='in_person_consultation'),
    'confirmed'
  );
  perform public.set_appointment_status(
    (select appointment_id from pr178_e2e_ids where appointment_type='in_person_consultation'),
    'no_show'
  );

  perform public.set_appointment_status(
    (select appointment_id from pr178_e2e_ids where appointment_type='touch_up'),
    'cancelled'
  );

  begin
    perform public.schedule_appointment(
      v_artist, v_consult_client, 'tattoo_session',
      v_start + interval '1 day', v_start + interval '1 day 7 hours',
      'proposed', v_consult_enquiry, null, 'must fail without project'
    );
    raise exception 'tattoo session without project was accepted';
  exception
    when sqlstate '22023' then null;
  end;
end
\$e2e\$;

reset role;

do \$verify\$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.sessions s
  join pr178_e2e_ids i on i.appointment_id = s.id
  where s.appointment_type = i.appointment_type
    and s.client_id is not null;
  if v_count <> 4 then
    raise exception 'hosted rows did not preserve all four appointment types';
  end if;

  select count(*) into v_count
  from public.sessions s
  join pr178_e2e_ids i on i.appointment_id = s.id
  where i.appointment_type in ('in_person_consultation','video_consultation')
    and s.project_id is null;
  if v_count <> 2 then
    raise exception 'projectless consultation verification failed';
  end if;

  select count(*) into v_count
  from public.integration_outbox o
  join pr178_e2e_ids i on i.appointment_id = o.session_id
  where o.kind = 'calendar_create';
  if v_count < 2 then
    raise exception 'confirmed consultations did not reach the durable calendar outbox boundary';
  end if;

  select count(*) into v_count
  from public.activity_log a
  join pr178_e2e_ids i on i.appointment_id = a.session_id
  where a.event_type = 'appointment.scheduled';
  if v_count <> 4 then
    raise exception 'appointment scheduling activity was not recorded for all four types';
  end if;

  select count(*) into v_count
  from public.activity_log a
  join pr178_e2e_ids i on i.appointment_id = a.session_id
  where a.event_type = 'appointment.status_changed';
  if v_count < 5 then
    raise exception 'appointment lifecycle activity coverage was incomplete';
  end if;
end
\$verify\$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (
      select id from public.profiles
      where role = 'read_only' and is_active
      order by id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);

set local role authenticated;

do \$readonly\$
declare
  v_artist constant uuid := '${VLADIMIR_ID}'::uuid;
  v_client uuid;
begin
  select id into v_client
  from public.clients
  where email ~* '@example\\.(invalid|com)$'
  order by created_at, id
  limit 1;

  begin
    perform public.schedule_appointment(
      v_artist, v_client, 'video_consultation',
      now() + interval '500 days',
      now() + interval '500 days 30 minutes',
      'proposed', null, null, 'read-only must fail'
    );
    raise exception 'read-only appointment write was accepted';
  exception
    when sqlstate '42501' then null;
  end;
end
\$readonly\$;

reset role;
rollback;

select jsonb_build_object(
  'ok', true,
  'appointment_types', 4,
  'projectless_consultations', 2,
  'conflict_domain', 'all_active_types',
  'lifecycle_checked', true,
  'read_only_denied', true,
  'transaction_rolled_back', true
) as summary;
SQL

  sql "${RUNNER_TEMP}/pr178-appointments-e2e.sql" "${evidence_dir}/appointments-e2e.json"
  rows "${evidence_dir}/appointments-e2e.json" | jq -e '
    .[-1].summary.ok == true
    and .[-1].summary.appointment_types == 4
    and .[-1].summary.projectless_consultations == 2
    and .[-1].summary.lifecycle_checked == true
    and .[-1].summary.read_only_denied == true
    and .[-1].summary.transaction_rolled_back == true
  ' >/dev/null || die "hosted appointment E2E summary was incomplete"

  snapshot "${evidence_dir}/database-after-e2e.json"
  after_migration="$(rows "${evidence_dir}/database-after.json" | jq -c '.[0].snapshot')"
  after_e2e="$(rows "${evidence_dir}/database-after-e2e.json" | jq -c '.[0].snapshot')"
  [ "$after_migration" = "$after_e2e" ] || die "synthetic appointment E2E left persistent rows"
}

deploy_crm() {
  require_env CLOUDFLARE_API_TOKEN
  require_env CLOUDFLARE_ACCOUNT_ID
  require_env VITE_SUPABASE_URL
  require_env VITE_SUPABASE_PUBLISHABLE_KEY

  (
    cd admin
    npm ci
    npm test
    npm run typecheck
    npm run build
  )

  test -f admin/dist/index.html
  grep -R -Fq 'All appointment types' admin/dist
  grep -R -Fq 'Все типы записей' admin/dist
  grep -R -Fq 'In-person consultation' admin/dist
  grep -R -Fq 'Видеоконсультация' admin/dist
  ! grep -R -E -q 'sb_secret_[A-Za-z0-9_-]{20,}' admin/dist

  npx wrangler pages deploy admin/dist \
    --project-name vishar-crm-staging \
    --branch main \
    --commit-hash "$GITHUB_SHA" \
    --commit-message "PR178 appointment types staging $GITHUB_SHA" \
    --commit-dirty=true \
    2>&1 | tee "${evidence_dir}/crm-deploy.txt"

  curl --silent --show-error --dump-header "${evidence_dir}/crm-access-headers.txt" \
    --output /dev/null "$CRM_ORIGIN/"
  status="$(awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' "${evidence_dir}/crm-access-headers.txt")"
  case "$status" in
    302|303) ;;
    *) die "CRM staging did not return a Cloudflare Access redirect after deployment (status $status)" ;;
  esac
  grep -Eiq '^location: .*cloudflareaccess\.com/' "${evidence_dir}/crm-access-headers.txt" \
    || die "CRM staging redirect did not target Cloudflare Access"
}

case "${1:-all}" in
  migrate) migrate_and_validate ;;
  e2e) run_hosted_appointment_e2e ;;
  deploy) deploy_crm ;;
  all)
    migrate_and_validate
    run_hosted_appointment_e2e
    deploy_crm
    ;;
  *) die "unknown mode ${1:-}" ;;
esac
