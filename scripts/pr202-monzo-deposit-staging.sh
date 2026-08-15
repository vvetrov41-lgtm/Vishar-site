#!/usr/bin/env bash
set -euo pipefail

# Guarded retained-staging validation for PR #202.
# Applies exactly 0042..0044, never resets retained staging, proves that the
# forward migrations do not mutate existing CRM/payment state, and runs one
# synthetic deposit/reconciliation transaction that is always rolled back.
# No Worker route, Monzo API, email provider, SMS provider, or production target
# is deployed or contacted by this script.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly EVIDENCE_DIR="${RUNNER_TEMP:?}/pr202-monzo-deposit-staging"
readonly EXPECTED_BEFORE="0041"
readonly EXPECTED_AFTER="0044"
readonly SYNTHETIC_ARTIST_ID="a1111111-1111-4111-8111-111111111111"

mkdir -p "$EVIDENCE_DIR"

die() { echo "PR202 retained staging validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/pr202-sql.XXXXXX.json")"
  chmod 600 "$request_file"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" > "$output_file"
  rm -f "$request_file"
  jq -e 'type == "array"' "$output_file" >/dev/null \
    || die "hosted SQL response was not a row array"
}

verify_project_health() {
  local raw="$RUNNER_TEMP/pr202-project.json"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}" > "$raw"
  jq -e --arg ref "$PROJECT_REF" \
    '.id == $ref and .status == "ACTIVE_HEALTHY" and .region == "eu-west-2"' \
    "$raw" >/dev/null || die "retained staging is not the expected ACTIVE_HEALTHY project"
  jq '{id,status,region,database:{version:.database.version}}' "$raw" \
    > "$EVIDENCE_DIR/project-safe.json"
  rm -f "$raw"
}

write_snapshot() {
  local label="$1"
  local query="$RUNNER_TEMP/pr202-${label}.sql"
  local raw="$RUNNER_TEMP/pr202-${label}.json"
  cat > "$query" <<'SQL'
select jsonb_build_object(
  'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
  'core_counts', jsonb_build_object(
    'profiles', (select count(*)::integer from public.profiles),
    'memberships', (select count(*)::integer from public.artist_memberships),
    'clients', (select count(*)::integer from public.clients),
    'enquiries', (select count(*)::integer from public.enquiries),
    'projects', (select count(*)::integer from public.projects),
    'sessions', (select count(*)::integer from public.sessions),
    'activity_log', (select count(*)::integer from public.activity_log),
    'outbox', (select count(*)::integer from public.integration_outbox)
  ),
  'payment_state', jsonb_build_object(
    'requests', (select count(*)::integer from public.payment_requests),
    'transactions', (select count(*)::integer from public.payment_transactions),
    'policies', (select count(*)::integer from public.artist_payment_policies),
    'payment_integrations', (select count(*)::integer from public.artist_integrations where integration_type='payments')
  ),
  'outbox_counts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'artist_id', artist_id, 'kind', kind, 'status', status, 'count', n
    ) order by artist_id, kind, status)
    from (
      select artist_id, kind, status, count(*)::integer n
      from public.integration_outbox
      group by artist_id, kind, status
    ) q
  ), '[]'::jsonb),
  'integrations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id,
      'artist_id', artist_id,
      'integration_type', integration_type,
      'provider', provider,
      'integration_key', integration_key,
      'is_enabled', is_enabled,
      'label_md5', md5(coalesce(external_account_label, '')),
      'configuration_md5', md5(configuration::text),
      'created_at', created_at,
      'updated_at', updated_at
    ) order by id)
    from public.artist_integrations
  ), '[]'::jsonb),
  'booking_sources', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id,
      'artist_id', artist_id,
      'source_key', source_key,
      'allowed_origin_md5', md5(allowed_origin),
      'form_version', form_version,
      'is_active', is_active,
      'created_at', created_at,
      'updated_at', updated_at
    ) order by id)
    from public.booking_sources
  ), '[]'::jsonb),
  'calendar_sessions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id,
      'artist_id', artist_id,
      'start_at', start_at,
      'end_at', end_at,
      'status', status,
      'calendar_provider', calendar_provider,
      'calendar_event_id', calendar_event_id,
      'calendar_version', calendar_version,
      'calendar_sync_status', calendar_sync_status,
      'calendar_last_synced_version', calendar_last_synced_version,
      'calendar_last_synced_at', calendar_last_synced_at,
      'calendar_last_error_code', calendar_last_error_code
    ) order by id)
    from public.sessions
    where calendar_version > 0 or calendar_event_id is not null
  ), '[]'::jsonb)
) as snapshot;
SQL
  sql "$query" "$raw"
  jq -e 'length == 1 and (.[0].snapshot | type == "object")' "$raw" >/dev/null \
    || die "invalid retained-staging snapshot"
  jq -S '.[0].snapshot' "$raw" > "$EVIDENCE_DIR/${label}.json"
  rm -f "$query" "$raw"
}

read_migration_versions() {
  local file="$1"
  awk -F'|' '{gsub(/[[:space:]`]/,"",$2); if ($2 ~ /^[0-9]{4}$/) print $2}' "$file"
}

verify_exact_history() {
  local file="$1" expected_count="$2" expected_last="$3"
  mapfile -t versions < <(read_migration_versions "$file")
  [ "${#versions[@]}" -eq "$expected_count" ] || die "unexpected migration count in $file"
  [ "${versions[-1]}" = "$expected_last" ] || die "unexpected latest migration in $file"
  for ((i = 1; i <= expected_count; i += 1)); do
    [ "${versions[i - 1]}" = "$(printf '%04d' "$i")" ] \
      || die "retained staging migration history has a gap at $(printf '%04d' "$i")"
  done
}

prepare_and_apply() {
  supabase link --project-ref "$PROJECT_REF" --password "$STAGING_SUPABASE_DB_PASSWORD"
  supabase migration list --linked > "$EVIDENCE_DIR/migrations-before.txt"
  verify_exact_history "$EVIDENCE_DIR/migrations-before.txt" 41 "$EXPECTED_BEFORE"

  write_snapshot before
  jq -e --arg expected "$EXPECTED_BEFORE" '.latest_migration == $expected' \
    "$EVIDENCE_DIR/before.json" >/dev/null || die "pre-state is not at migration 0041"
  jq -e '
    .payment_state.requests == 0
    and .payment_state.transactions == 0
    and .payment_state.policies == 0
    and .payment_state.payment_integrations == 0
  ' "$EVIDENCE_DIR/before.json" >/dev/null \
    || die "retained staging payment baseline is no longer empty"

  supabase db push --linked --password "$STAGING_SUPABASE_DB_PASSWORD" --dry-run 2>&1 \
    | tee "$EVIDENCE_DIR/migration-dry-run.txt"
  for migration in \
    0042_monzo_easy_bank_transfer_deposits.sql \
    0043_monzo_reconciliation_guard.sql \
    0044_monzo_payment_url_validator.sql; do
    grep -Fq "$migration" "$EVIDENCE_DIR/migration-dry-run.txt" \
      || die "dry-run omitted $migration"
  done
  if grep -E '004[5-9]_|00[5-9][0-9]_' "$EVIDENCE_DIR/migration-dry-run.txt" >/dev/null; then
    die "dry-run included a migration after 0044"
  fi

  supabase db push --linked --password "$STAGING_SUPABASE_DB_PASSWORD" --yes
  supabase migration list --linked > "$EVIDENCE_DIR/migrations-after.txt"
  verify_exact_history "$EVIDENCE_DIR/migrations-after.txt" 44 "$EXPECTED_AFTER"
}

verify_schema_and_acl() {
  local query="$RUNNER_TEMP/pr202-security.sql"
  local raw="$RUNNER_TEMP/pr202-security.json"
  cat > "$query" <<'SQL'
select jsonb_build_object(
  'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
  'links_force_rls', (select relrowsecurity and relforcerowsecurity from pg_class where oid='public.payment_request_links'::regclass),
  'candidates_force_rls', (select relrowsecurity and relforcerowsecurity from pg_class where oid='public.payment_reconciliation_candidates'::regclass),
  'links_policy_count', (select count(*)::integer from pg_policies where schemaname='public' and tablename='payment_request_links'),
  'candidates_policy_count', (select count(*)::integer from pg_policies where schemaname='public' and tablename='payment_reconciliation_candidates'),
  'auth_links_select', has_table_privilege('authenticated','public.payment_request_links','SELECT'),
  'service_links_select', has_table_privilege('service_role','public.payment_request_links','SELECT'),
  'auth_candidates_select', has_table_privilege('authenticated','public.payment_reconciliation_candidates','SELECT'),
  'service_candidates_select', has_table_privilege('service_role','public.payment_reconciliation_candidates','SELECT'),
  'configure_anon', has_function_privilege('anon','public.configure_monzo_easy_bank_transfer(uuid,text,boolean)','EXECUTE'),
  'configure_auth', has_function_privilege('authenticated','public.configure_monzo_easy_bank_transfer(uuid,text,boolean)','EXECUTE'),
  'configure_service', has_function_privilege('service_role','public.configure_monzo_easy_bank_transfer(uuid,text,boolean)','EXECUTE'),
  'settings_anon', has_function_privilege('anon','public.get_monzo_easy_bank_transfer_settings(uuid)','EXECUTE'),
  'settings_auth', has_function_privilege('authenticated','public.get_monzo_easy_bank_transfer_settings(uuid)','EXECUTE'),
  'settings_service', has_function_privilege('service_role','public.get_monzo_easy_bank_transfer_settings(uuid)','EXECUTE'),
  'request_anon', has_function_privilege('anon','public.request_session_deposit(uuid,uuid,text)','EXECUTE'),
  'request_auth', has_function_privilege('authenticated','public.request_session_deposit(uuid,uuid,text)','EXECUTE'),
  'request_service', has_function_privilege('service_role','public.request_session_deposit(uuid,uuid,text)','EXECUTE'),
  'resolve_anon', has_function_privilege('anon','public.resolve_monzo_deposit_redirect(uuid)','EXECUTE'),
  'resolve_auth', has_function_privilege('authenticated','public.resolve_monzo_deposit_redirect(uuid)','EXECUTE'),
  'resolve_service', has_function_privilege('service_role','public.resolve_monzo_deposit_redirect(uuid)','EXECUTE'),
  'reconcile_anon', has_function_privilege('anon','public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)','EXECUTE'),
  'reconcile_auth', has_function_privilege('authenticated','public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)','EXECUTE'),
  'reconcile_service', has_function_privilege('service_role','public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)','EXECUTE')
) as checks;
SQL
  sql "$query" "$raw"
  jq -S '.[0].checks' "$raw" > "$EVIDENCE_DIR/security-checks.json"
  rm -f "$query" "$raw"

  jq -e --arg expected "$EXPECTED_AFTER" '
    .latest_migration == $expected
    and .links_force_rls == true
    and .candidates_force_rls == true
    and .links_policy_count == 0
    and .candidates_policy_count == 0
    and .auth_links_select == false
    and .service_links_select == false
    and .auth_candidates_select == false
    and .service_candidates_select == false
    and .configure_anon == false and .configure_auth == true and .configure_service == false
    and .settings_anon == false and .settings_auth == true and .settings_service == false
    and .request_anon == false and .request_auth == true and .request_service == false
    and .resolve_anon == false and .resolve_auth == false and .resolve_service == true
    and .reconcile_anon == false and .reconcile_auth == false and .reconcile_service == true
  ' "$EVIDENCE_DIR/security-checks.json" >/dev/null \
    || die "hosted payment RLS/RPC ACL boundary is invalid"
}

run_synthetic_e2e_rollback() {
  local query="$RUNNER_TEMP/pr202-synthetic-e2e.sql"
  local raw="$RUNNER_TEMP/pr202-synthetic-e2e.json"
  cat > "$query" <<'SQL'
begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('c7111111-1111-4111-8111-111111111111', 'pr202-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('c7111111-1111-4111-8111-111111111111', 'pr202-owner@example.test', 'PR202 Synthetic Owner', 'owner', true);

insert into public.clients (id, full_name, email) values
  ('c7211111-1111-4111-8111-111111111111', 'PR202 Synthetic Client', 'pr202-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'c7311111-1111-4111-8111-111111111111',
  'c7211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'c7411111-1111-4111-8111-111111111111', repeat('d', 64),
  'accepted', 'complete', 'PR202 Synthetic Client', 'pr202-client@example.test',
  '2026-07-29', now()
);

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values (
  'c7511111-1111-4111-8111-111111111111',
  'c7211111-1111-4111-8111-111111111111',
  'c7311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PR202 Synthetic Project', 'active', 'GBP'
);

insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values (
  'c7611111-1111-4111-8111-111111111111',
  'c7511111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'proposed',
  date_trunc('day', now()) + interval '20 days 10 hours',
  date_trunc('day', now()) + interval '20 days 17 hours'
);

select set_config('request.jwt.claims', '{"sub":"c7111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select public.configure_monzo_easy_bank_transfer(
  'a1111111-1111-4111-8111-111111111111',
  'https://monzo.com/pay/r/synthetic-vladimir_250',
  true
);

create temporary table first_request as
select public.request_session_deposit(
  'c7611111-1111-4111-8111-111111111111',
  'c7711111-1111-4111-8111-111111111111',
  'email'
) as result;
grant select on first_request to authenticated, service_role;

create temporary table replay_request as
select public.request_session_deposit(
  'c7611111-1111-4111-8111-111111111111',
  'c7722222-2222-4222-8222-222222222222',
  'copy_link'
) as result;
grant select on replay_request to authenticated, service_role;

reset role;
create temporary table link_fixture as
select l.id, l.public_id, l.payment_request_id
from public.payment_request_links l
where l.payment_request_id = (select (result ->> 'payment_request_id')::uuid from first_request);
grant select on link_fixture to authenticated, service_role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
create temporary table resolved as
select public.resolve_monzo_deposit_redirect((select public_id from link_fixture)) as destination;
grant select on resolved to service_role;

create temporary table candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'evt_pr202_synthetic_001',
  'tx_pr202_synthetic_001',
  250.00,
  'GBP',
  now()
) as result;
grant select on candidate to service_role;

reset role;

do $$
declare
  v_first jsonb := (select result from first_request);
  v_replay jsonb := (select result from replay_request);
  v_candidate jsonb := (select result from candidate);
begin
  if (v_first ->> 'amount')::numeric <> 250::numeric
     or v_first ->> 'currency' <> 'GBP'
     or v_first ->> 'delivery_status' <> 'queued_provider_not_connected'
     or v_first ->> 'public_path' not like '/pay-by-bank-transfer/%' then
    raise exception 'synthetic deposit request result is invalid';
  end if;

  if v_replay ->> 'payment_request_id' <> v_first ->> 'payment_request_id' then
    raise exception 'synthetic deposit replay created another request';
  end if;

  if (select count(*) from public.payment_request_links where payment_request_id=(v_first->>'payment_request_id')::uuid) <> 1 then
    raise exception 'synthetic deposit does not have exactly one opaque link';
  end if;

  if (select count(*) from public.integration_outbox where kind='transactional_email' and session_id='c7611111-1111-4111-8111-111111111111') <> 1 then
    raise exception 'synthetic deposit email outbox dedupe is invalid';
  end if;

  if (select destination from resolved) <> 'https://monzo.com/pay/r/synthetic-vladimir_250' then
    raise exception 'backend redirect did not resolve the synthetic artist route';
  end if;

  if (select open_count from public.payment_request_links where payment_request_id=(v_first->>'payment_request_id')::uuid) <> 1 then
    raise exception 'redirect open accounting is invalid';
  end if;

  if (select status::text from public.payment_requests where id=(v_first->>'payment_request_id')::uuid) <> 'pending' then
    raise exception 'opening the synthetic link changed payment state';
  end if;

  if (select count(*) from public.payment_transactions where payment_request_id=(v_first->>'payment_request_id')::uuid) <> 0 then
    raise exception 'synthetic redirect/reconciliation wrote the payment ledger';
  end if;

  if v_candidate ->> 'status' <> 'candidate' then
    raise exception 'verified synthetic Monzo metadata did not remain a candidate';
  end if;

  if (select fixed_amount from public.artist_payment_policies where artist_id='a1111111-1111-4111-8111-111111111111' and is_active order by version desc limit 1) <> 250::numeric then
    raise exception 'synthetic Monzo setup did not enforce the GBP 250 policy';
  end if;
end
$$;

rollback;
select jsonb_build_object('synthetic_transaction_rolled_back', true) as result;
SQL

  sql "$query" "$raw"
  jq -e 'length == 1 and .[0].result.synthetic_transaction_rolled_back == true' "$raw" >/dev/null \
    || die "synthetic Monzo E2E did not complete and roll back"
  jq -S '.[0].result' "$raw" > "$EVIDENCE_DIR/synthetic-e2e.json"
  rm -f "$query" "$raw"
}

verify_post_state() {
  verify_project_health
  write_snapshot after
  jq -e --arg expected "$EXPECTED_AFTER" '.latest_migration == $expected' \
    "$EVIDENCE_DIR/after.json" >/dev/null || die "retained staging did not reach exactly 0044"

  for key in core_counts payment_state outbox_counts integrations booking_sources calendar_sessions; do
    diff -u \
      <(jq -S ".${key}" "$EVIDENCE_DIR/before.json") \
      <(jq -S ".${key}" "$EVIDENCE_DIR/after.json") >/dev/null \
      || die "forward migration or rolled-back E2E changed pre-existing ${key}"
  done

  jq -e '
    .payment_state.requests == 0
    and .payment_state.transactions == 0
    and .payment_state.policies == 0
    and .payment_state.payment_integrations == 0
  ' "$EVIDENCE_DIR/after.json" >/dev/null \
    || die "synthetic payment state survived rollback"

  local query="$RUNNER_TEMP/pr202-synthetic-clean.sql"
  local raw="$RUNNER_TEMP/pr202-synthetic-clean.json"
  cat > "$query" <<'SQL'
select jsonb_build_object(
  'synthetic_auth_users', (select count(*)::integer from auth.users where id='c7111111-1111-4111-8111-111111111111'),
  'synthetic_profiles', (select count(*)::integer from public.profiles where id='c7111111-1111-4111-8111-111111111111'),
  'synthetic_clients', (select count(*)::integer from public.clients where id='c7211111-1111-4111-8111-111111111111'),
  'synthetic_sessions', (select count(*)::integer from public.sessions where id='c7611111-1111-4111-8111-111111111111'),
  'synthetic_webhook_events', (select count(*)::integer from public.payment_webhook_events where provider_event_id='evt_pr202_synthetic_001'),
  'synthetic_candidates', (select count(*)::integer from public.payment_reconciliation_candidates where provider_transaction_id='tx_pr202_synthetic_001')
) as checks;
SQL
  sql "$query" "$raw"
  jq -S '.[0].checks' "$raw" > "$EVIDENCE_DIR/rollback-checks.json"
  rm -f "$query" "$raw"
  jq -e 'to_entries | all(.value == 0)' "$EVIDENCE_DIR/rollback-checks.json" >/dev/null \
    || die "synthetic staging E2E left durable rows"

  supabase db lint --linked --schema public,crm_private --level error --fail-on error 2>&1 \
    | tee "$EVIDENCE_DIR/hosted-lint.txt"
  npm run scan:secrets | tee "$EVIDENCE_DIR/final-secret-scan.txt"

  jq -n --arg head_sha "${APPROVED_SHA:?}" '{
    project_ref:"gwaliusblwrzisrwnsvs",
    migration_before:"0041",
    migration_after:"0044",
    head_sha:$head_sha,
    production_targeted:false,
    retained_staging_reset:false,
    existing_crm_rows_unchanged:true,
    existing_outbox_unchanged:true,
    existing_integrations_unchanged:true,
    existing_booking_sources_unchanged:true,
    existing_calendar_sessions_unchanged:true,
    payment_baseline_preserved:true,
    synthetic_e2e_rolled_back:true,
    fixed_deposit_gbp:250,
    public_link_open_does_not_settle:true,
    reconciliation_does_not_settle:true,
    payment_tables_force_rls:true,
    browser_direct_payment_table_access:false,
    redirect_worker_deployed:false,
    monzo_api_connected:false,
    email_provider_connected:false,
    sms_provider_connected:false,
    hosted_lint:"passed",
    secret_scan:"passed"
  }' > "$EVIDENCE_DIR/summary.json"
}

for name in SUPABASE_ACCESS_TOKEN STAGING_SUPABASE_DB_PASSWORD SUPABASE_DB_PASSWORD APPROVED_SHA; do
  require_env "$name"
done
[ "${PRODUCTION_TARGETED:-false}" = 'false' ] || die "production target must remain false"
verify_project_health
prepare_and_apply
verify_schema_and_acl
run_synthetic_e2e_rollback
verify_post_state

echo "PR202 retained staging forward migration 0042..0044 and rolled-back synthetic payment validation succeeded"
