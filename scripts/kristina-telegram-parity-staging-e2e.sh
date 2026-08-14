#!/usr/bin/env bash
set -euo pipefail

# Guarded retained-staging parity validation. This provisions one metadata-only
# Kristina Telegram route plus one fully synthetic enquiry/file/outbox fixture.
# The only provider call is made by workers/lib/telegram-drain.js for the exact
# target UUID.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly STAGING_ORIGIN="https://${PROJECT_REF}.supabase.co"
readonly VLADIMIR_ARTIST_ID="a1111111-1111-4111-8111-111111111111"
readonly KRISTINA_ARTIST_ID="a2222222-2222-4222-8222-222222222222"
readonly KRISTINA_INTEGRATION_ID="276b7b50-2a9f-49ba-994f-5856a2d84044"
readonly KRISTINA_INTEGRATION_KEY="kristina-staging"
readonly KRISTINA_BINDING="ARTIST_TELEGRAM_KRISTINA_HSTAGING"
readonly PR189_TARGET_ID="8ac18567-a323-459f-b5a5-9463c0485c6e"
readonly SYNTHETIC_CLIENT_ID="22ecc10d-0e68-41ab-84b6-1ecdf725168f"
readonly SYNTHETIC_ENQUIRY_ID="72e570f3-b767-45da-a74c-2872b910be9d"
readonly SYNTHETIC_FILE_ID="b59d04aa-7a47-4281-aa95-dfb262ded95b"
readonly TARGET_OUTBOX_ID="271407db-640d-405b-bc89-4838cf8d56b5"
readonly SYNTHETIC_IDEMPOTENCY_ID="701287f5-026f-4169-998e-1d157fac6dff"
readonly VALIDATION_MARKER="kristina_telegram_parity_271407db"
readonly DEDUPE_KEY="telegram:validation:kristina-parity:${TARGET_OUTBOX_ID}"
readonly HISTORICAL_IDS=(
  4bf5cb94-60cd-4347-b292-fc0af986fc1f
  bb3c2e92-d8e8-4a54-9c8f-531c058c36bf
  ad5a8e18-b52b-4fd2-ab15-fd5af1f696e1
  7d1e9026-449f-45db-81e9-4aeb2ed0d933
  cec412cf-ecd8-4136-a1ef-c4787457ff6e
  9a776cfb-3cbf-4cac-aaa1-8912e65103a0
  c783e8e2-bc8b-4fcb-a5bf-f685e55fcbba
)

readonly EVIDENCE_DIR="${RUNNER_TEMP:?}/kristina-telegram-parity-evidence"
mkdir -p "$EVIDENCE_DIR"

BASELINE_MODE=''
EXPECTED_BEFORE_ATTEMPT=0
EXPECTED_AFTER_ATTEMPT=0
EXPECTED_FAILED_ACTIVITY_COUNT=0

die() { echo "Kristina Telegram parity validation failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file
  request_file="$(mktemp "${RUNNER_TEMP}/kristina-telegram-sql.XXXXXX.json")"
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

normalise_snapshot() {
  local raw_file="$1" output_file="$2"
  jq -e 'length == 1 and (.[0].snapshot | type == "object")' "$raw_file" >/dev/null \
    || die "invalid retained-staging snapshot"
  jq -S '.[0].snapshot' "$raw_file" > "$output_file"
}

write_snapshot() {
  local label="$1" sql_file raw_file
  sql_file="${RUNNER_TEMP}/kristina-snapshot-${label}.sql"
  raw_file="${RUNNER_TEMP}/kristina-snapshot-${label}.raw.json"
  cat > "$sql_file" <<'SQL'
select jsonb_build_object(
  'latest_migration', (select max(version) from supabase_migrations.schema_migrations),
  'artists', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'slug', a.slug, 'is_active', a.is_active,
      'updated_at', a.updated_at
    ) order by a.id)
    from public.artists a
    where a.id in (
      'a1111111-1111-4111-8111-111111111111'::uuid,
      'a2222222-2222-4222-8222-222222222222'::uuid
    )
  ), '[]'::jsonb),
  'kristina_booking_source', (
    select jsonb_build_object(
      'id', b.id, 'artist_id', b.artist_id, 'source_key', b.source_key,
      'allowed_origin', b.allowed_origin, 'form_version', b.form_version,
      'is_active', b.is_active, 'created_at', b.created_at, 'updated_at', b.updated_at
    )
    from public.booking_sources b
    where b.source_key = 'kristina-website'
  ),
  'integrations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', i.id, 'artist_id', i.artist_id,
      'integration_type', i.integration_type, 'provider', i.provider,
      'integration_key', i.integration_key, 'is_enabled', i.is_enabled,
      'external_account_label_md5', md5(coalesce(i.external_account_label, '')),
      'configuration_md5', md5(i.configuration::text),
      'created_at', i.created_at, 'updated_at', i.updated_at
    ) order by i.id)
    from public.artist_integrations i
  ), '[]'::jsonb),
  'telegram_counts', jsonb_build_object(
    'succeeded', count(*) filter (where o.status = 'succeeded'),
    'failed', count(*) filter (where o.status = 'failed'),
    'pending', count(*) filter (where o.status = 'pending'),
    'leased', count(*) filter (where o.status = 'leased'),
    'dead', count(*) filter (where o.status = 'dead'),
    'total', count(*)
  ),
  'telegram_by_artist', coalesce((
    select jsonb_agg(jsonb_build_object(
      'artist_id', x.artist_id, 'status', x.status, 'count', x.n
    ) order by x.artist_id, x.status)
    from (
      select t.artist_id, t.status, count(*)::integer as n
      from public.integration_outbox t
      where t.kind = 'telegram_notification'
      group by t.artist_id, t.status
    ) x
  ), '[]'::jsonb),
  'telegram_rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'artist_id', t.artist_id, 'enquiry_id', t.enquiry_id,
      'client_id', t.client_id, 'kind', t.kind, 'status', t.status,
      'attempt_count', t.attempt_count, 'max_attempts', t.max_attempts,
      'next_attempt_at', t.next_attempt_at, 'leased_by', t.leased_by,
      'leased_at', t.leased_at, 'lease_expires_at', t.lease_expires_at,
      'last_error_code', t.last_error_code,
      'payload_md5', md5(t.payload::text),
      'created_at', t.created_at, 'updated_at', t.updated_at
    ) order by t.id)
    from public.integration_outbox t
    where t.kind = 'telegram_notification'
  ), '[]'::jsonb),
  'target_due', exists(
    select 1 from public.integration_outbox d
    where d.id = '271407db-640d-405b-bc89-4838cf8d56b5'::uuid
      and d.status = 'failed' and d.next_attempt_at <= now()
  ),
  'target_activities', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'event_type', l.event_type, 'outbox_id', l.outbox_id,
      'enquiry_id', l.enquiry_id, 'metadata', l.metadata,
      'created_at', l.created_at
    ) order by l.created_at)
    from public.activity_log l
    where l.outbox_id = '271407db-640d-405b-bc89-4838cf8d56b5'::uuid
  ), '[]'::jsonb),
  'kristina_fixture', (
    select jsonb_build_object(
      'id', e.id, 'artist_id', e.artist_id,
      'email_domain', split_part(lower(e.submitted_email), '@', 2),
      'intake_state', e.intake_state,
      'file_count', (select count(*) from public.enquiry_files f where f.enquiry_id = e.id),
      'ready_file_count', (select count(*) from public.enquiry_files f where f.enquiry_id = e.id and f.upload_state = 'ready')
    )
    from public.enquiries e
    where e.id = '72e570f3-b767-45da-a74c-2872b910be9d'::uuid
  ),
  'historical', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', h.id, 'status', h.status, 'attempt_count', h.attempt_count,
      'max_attempts', h.max_attempts, 'next_attempt_at', h.next_attempt_at,
      'leased_by', h.leased_by, 'leased_at', h.leased_at,
      'lease_expires_at', h.lease_expires_at,
      'last_error_code', h.last_error_code, 'updated_at', h.updated_at
    ) order by h.id)
    from public.integration_outbox h
    where h.id = any(array[
      '4bf5cb94-60cd-4347-b292-fc0af986fc1f'::uuid,
      'bb3c2e92-d8e8-4a54-9c8f-531c058c36bf'::uuid,
      'ad5a8e18-b52b-4fd2-ab15-fd5af1f696e1'::uuid,
      '7d1e9026-449f-45db-81e9-4aeb2ed0d933'::uuid,
      'cec412cf-ecd8-4136-a1ef-c4787457ff6e'::uuid,
      '9a776cfb-3cbf-4cac-aaa1-8912e65103a0'::uuid,
      'c783e8e2-bc8b-4fcb-a5bf-f685e55fcbba'::uuid
    ])
  ), '[]'::jsonb)
) as snapshot
from public.integration_outbox o
where o.kind = 'telegram_notification';
SQL
  sql "$sql_file" "$raw_file"
  normalise_snapshot "$raw_file" "${EVIDENCE_DIR}/${label}.json"
  rm -f "$sql_file" "$raw_file"
}

verify_project_health() {
  local label="$1" raw_file
  raw_file="${RUNNER_TEMP}/supabase-project-${label}.json"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}" > "$raw_file"
  jq -e --arg ref "$PROJECT_REF" '.id == $ref and .status == "ACTIVE_HEALTHY"' "$raw_file" >/dev/null \
    || die "retained staging project is not ACTIVE_HEALTHY"
  jq '{id,status,region,database:{version:.database.version}}' "$raw_file" \
    > "${EVIDENCE_DIR}/project-${label}.json"
  rm -f "$raw_file"
}

verify_historical_shape() {
  local snapshot="$1"
  jq -e --arg artist "$VLADIMIR_ARTIST_ID" '
    (.historical | length) == 7
    and all(.historical[];
      .status == "failed"
      and .attempt_count == 1
      and .last_error_code == "provider_route_unavailable"
      and .leased_by == null
      and .leased_at == null
      and .lease_expires_at == null
    )
  ' "$snapshot" >/dev/null || die "historical failure fingerprint changed"
  for id in "${HISTORICAL_IDS[@]}"; do
    jq -e --arg id "$id" 'any(.historical[]; .id == $id)' "$snapshot" >/dev/null \
      || die "historical Telegram failure $id is absent"
  done
}

verify_baseline() {
  verify_project_health before
  write_snapshot before
  verify_historical_shape "${EVIDENCE_DIR}/before.json"
  if jq -e \
    --arg vladimir "$VLADIMIR_ARTIST_ID" \
    --arg kristina "$KRISTINA_ARTIST_ID" \
    --arg pr189 "$PR189_TARGET_ID" \
    --arg target "$TARGET_OUTBOX_ID" '
    .latest_migration == "0035"
    and .telegram_counts == {succeeded:9, failed:7, pending:0, leased:0, dead:0, total:16}
    and (.telegram_rows | length) == 16
    and all(.telegram_rows[]; .artist_id == $vladimir)
    and any(.telegram_rows[];
      .id == $pr189 and .status == "succeeded" and .attempt_count == 2
      and .last_error_code == null and .leased_by == null
      and .leased_at == null and .lease_expires_at == null
    )
    and all(.telegram_rows[]; .id != $target)
    and (.artists | length) == 2
    and all(.artists[]; .is_active == true)
    and .kristina_booking_source.artist_id == $kristina
    and .kristina_booking_source.source_key == "kristina-website"
    and .kristina_booking_source.is_active == false
    and .kristina_booking_source.allowed_origin == null
    and any(.integrations[];
      .artist_id == $vladimir and .integration_type == "telegram"
      and .provider == "telegram" and .integration_key == "vladimir-staging"
      and .is_enabled == true
    )
    and all(.integrations[];
      .artist_id != $kristina or .integration_type != "telegram"
    )
    and .target_activities == []
    and .kristina_fixture == null
  ' "${EVIDENCE_DIR}/before.json" >/dev/null; then
    BASELINE_MODE='fresh'
    EXPECTED_BEFORE_ATTEMPT=1
    EXPECTED_AFTER_ATTEMPT=2
    EXPECTED_FAILED_ACTIVITY_COUNT=0
    return
  fi

  jq -e \
    --arg vladimir "$VLADIMIR_ARTIST_ID" \
    --arg kristina "$KRISTINA_ARTIST_ID" \
    --arg pr189 "$PR189_TARGET_ID" \
    --arg target "$TARGET_OUTBOX_ID" \
    --arg integration "$KRISTINA_INTEGRATION_ID" '
    .latest_migration == "0035"
    and .telegram_counts == {succeeded:9, failed:8, pending:0, leased:0, dead:0, total:17}
    and (.telegram_rows | length) == 17
    and all(.telegram_rows[]; .artist_id == $vladimir or .id == $target)
    and any(.telegram_rows[];
      .id == $pr189 and .status == "succeeded" and .attempt_count == 2
      and .last_error_code == null and .leased_by == null
      and .leased_at == null and .lease_expires_at == null
    )
    and any(.telegram_rows[];
      .id == $target and .artist_id == $kristina
      and .status == "failed" and .attempt_count == 2
      and .max_attempts == 8 and .last_error_code == "telegram_rejected"
      and .leased_by == null and .leased_at == null and .lease_expires_at == null
    )
    and .target_due == true
    and (.artists | length) == 2
    and all(.artists[]; .is_active == true)
    and .kristina_booking_source.artist_id == $kristina
    and .kristina_booking_source.source_key == "kristina-website"
    and .kristina_booking_source.is_active == false
    and .kristina_booking_source.allowed_origin == null
    and any(.integrations[];
      .artist_id == $vladimir and .integration_type == "telegram"
      and .provider == "telegram" and .integration_key == "vladimir-staging"
      and .is_enabled == true
    )
    and any(.integrations[];
      .id == $integration and .artist_id == $kristina
      and .integration_type == "telegram" and .provider == "telegram"
      and .integration_key == "kristina-staging" and .is_enabled == true
    )
    and ([.integrations[] | select(.artist_id == $kristina and .integration_type == "telegram")] | length) == 1
    and .kristina_fixture.id == "72e570f3-b767-45da-a74c-2872b910be9d"
    and .kristina_fixture.artist_id == $kristina
    and .kristina_fixture.email_domain == "example.invalid"
    and .kristina_fixture.intake_state == "complete"
    and .kristina_fixture.file_count == 1
    and .kristina_fixture.ready_file_count == 1
    and (.target_activities | length) == 1
    and .target_activities[0].event_type == "outbox.failed"
    and .target_activities[0].outbox_id == $target
    and .target_activities[0].enquiry_id == "72e570f3-b767-45da-a74c-2872b910be9d"
    and .target_activities[0].metadata.lease_aware == true
    and .target_activities[0].metadata.attempt_count == 2
    and .target_activities[0].metadata.error_code == "telegram_rejected"
  ' "${EVIDENCE_DIR}/before.json" >/dev/null \
    || die "retained staging baseline does not match either guarded parity state"
  BASELINE_MODE='recovery'
  EXPECTED_BEFORE_ATTEMPT=2
  EXPECTED_AFTER_ATTEMPT=3
  EXPECTED_FAILED_ACTIVITY_COUNT=1
}

create_route_and_one_fixture() {
  local sql_file raw_file
  sql_file="${RUNNER_TEMP}/kristina-parity-setup.sql"
  raw_file="${RUNNER_TEMP}/kristina-parity-setup.raw.json"
  cat > "$sql_file" <<SQL
begin;
do \$setup\$
declare
  v_reference text;
begin
  perform pg_advisory_xact_lock(hashtext('kristina-telegram-parity-retained-staging'));
  if (select max(version) from supabase_migrations.schema_migrations) <> '0035' then
    raise exception 'retained staging migration history changed';
  end if;
  if exists (
    select 1 from public.artist_integrations
    where artist_id = '$KRISTINA_ARTIST_ID'::uuid and integration_type = 'telegram'
  ) then
    raise exception 'Kristina Telegram integration already exists';
  end if;
  if exists (
    select 1 from public.integration_outbox where id = '$TARGET_OUTBOX_ID'::uuid
  ) or exists (
    select 1 from public.enquiries where id = '$SYNTHETIC_ENQUIRY_ID'::uuid
  ) or exists (
    select 1 from public.clients where id = '$SYNTHETIC_CLIENT_ID'::uuid
  ) then
    raise exception 'Kristina synthetic fixture already exists';
  end if;
  if not exists (
    select 1 from public.booking_sources
    where source_key = 'kristina-website'
      and artist_id = '$KRISTINA_ARTIST_ID'::uuid
      and is_active = false and allowed_origin is null
  ) then
    raise exception 'Kristina public booking source boundary changed';
  end if;

  insert into public.artist_integrations (
    id, artist_id, integration_type, provider, integration_key,
    external_account_label, configuration, is_enabled
  ) values (
    '$KRISTINA_INTEGRATION_ID'::uuid,
    '$KRISTINA_ARTIST_ID'::uuid,
    'telegram', 'telegram', '$KRISTINA_INTEGRATION_KEY',
    'Kristina CRM Staging',
    '{"environment":"staging","routing":"artist-scoped"}'::jsonb,
    true
  );

  insert into public.clients (id, full_name, email, phone, preferred_contact)
  values (
    '$SYNTHETIC_CLIENT_ID'::uuid,
    'Synthetic Kristina Telegram Parity',
    'kristina-telegram-parity@example.invalid',
    '+440000000190',
    'Email'
  );

  insert into public.enquiries (
    id, client_id, artist_id, reference_number, idempotency_key,
    intake_fingerprint, status, intake_state,
    submitted_full_name, submitted_email, submitted_phone,
    submitted_preferred_contact, project_type, placement,
    approximate_size, cover_up, preferred_timing, idea,
    source, privacy_notice_version, privacy_acknowledged_at
  ) values (
    '$SYNTHETIC_ENQUIRY_ID'::uuid,
    '$SYNTHETIC_CLIENT_ID'::uuid,
    '$KRISTINA_ARTIST_ID'::uuid,
    'ENQ-2026-0000',
    '$SYNTHETIC_IDEMPOTENCY_ID'::uuid,
    repeat('9', 64),
    'new', 'complete',
    'Synthetic Kristina Telegram Parity',
    'kristina-telegram-parity@example.invalid',
    '+440000000190',
    'Email', 'Synthetic staging validation', 'Synthetic placement',
    'Synthetic size', 'No', 'Synthetic timing',
    'Synthetic retained-staging Telegram parity validation only.',
    'synthetic:kristina-telegram-parity', '2026-08-11', now()
  ) returning reference_number into v_reference;

  insert into public.enquiry_files (
    id, enquiry_id, ordinal, storage_path, safe_extension,
    mime_type, byte_size, checksum, upload_state, uploaded_at
  ) values (
    '$SYNTHETIC_FILE_ID'::uuid,
    '$SYNTHETIC_ENQUIRY_ID'::uuid,
    0,
    public.enquiry_file_storage_path(
      '$SYNTHETIC_CLIENT_ID'::uuid,
      '$SYNTHETIC_ENQUIRY_ID'::uuid,
      '$SYNTHETIC_FILE_ID'::uuid,
      'jpg'
    ),
    'jpg', 'image/jpeg', 1, repeat('8', 64), 'ready', now()
  );

  insert into public.integration_outbox (
    id, artist_id, kind, dedupe_key, status, payload,
    client_id, enquiry_id, attempt_count, max_attempts,
    next_attempt_at, last_error_code
  ) values (
    '$TARGET_OUTBOX_ID'::uuid,
    '$KRISTINA_ARTIST_ID'::uuid,
    'telegram_notification',
    '$DEDUPE_KEY',
    'failed',
    jsonb_build_object(
      'enquiry_id', '$SYNTHETIC_ENQUIRY_ID'::uuid,
      'validation_marker', '$VALIDATION_MARKER'
    ),
    '$SYNTHETIC_CLIENT_ID'::uuid,
    '$SYNTHETIC_ENQUIRY_ID'::uuid,
    1, 8, now() - interval '1 minute', 'synthetic_retry_setup'
  );

  if v_reference !~ '^ENQ-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'synthetic reference was not assigned by the database';
  end if;
end
\$setup\$;
commit;

select jsonb_build_object(
  'integration_id', i.id,
  'integration_key', i.integration_key,
  'integration_enabled', i.is_enabled,
  'outbox_id', o.id,
  'artist_id', o.artist_id,
  'enquiry_id', o.enquiry_id,
  'reference_number', e.reference_number,
  'email_domain', split_part(lower(e.submitted_email), '@', 2),
  'intake_state', e.intake_state,
  'file_count', count(f.id),
  'ready_file_count', count(f.id) filter (where f.upload_state = 'ready'),
  'status', o.status,
  'attempt_count', o.attempt_count,
  'max_attempts', o.max_attempts,
  'due', o.next_attempt_at <= now(),
  'last_error_code', o.last_error_code,
  'lease_clear', o.leased_by is null and o.leased_at is null and o.lease_expires_at is null,
  'validation_marker', o.payload ->> 'validation_marker'
) as fixture
from public.integration_outbox o
join public.enquiries e on e.id = o.enquiry_id and e.artist_id = o.artist_id
join public.enquiry_files f on f.enquiry_id = e.id
join public.artist_integrations i
  on i.artist_id = o.artist_id and i.integration_type = 'telegram' and i.is_enabled
where o.id = '$TARGET_OUTBOX_ID'::uuid
group by i.id, i.integration_key, i.is_enabled, o.id, o.artist_id, o.enquiry_id,
         o.status, o.attempt_count, o.max_attempts, o.next_attempt_at,
         o.last_error_code, o.leased_by, o.leased_at, o.lease_expires_at,
         o.payload, e.reference_number, e.submitted_email, e.intake_state;
SQL
  sql "$sql_file" "$raw_file"
  jq -e \
    --arg integration "$KRISTINA_INTEGRATION_ID" \
    --arg key "$KRISTINA_INTEGRATION_KEY" \
    --arg outbox "$TARGET_OUTBOX_ID" \
    --arg artist "$KRISTINA_ARTIST_ID" \
    --arg enquiry "$SYNTHETIC_ENQUIRY_ID" \
    --arg marker "$VALIDATION_MARKER" '
    length == 1
    and .[0].fixture.integration_id == $integration
    and .[0].fixture.integration_key == $key
    and .[0].fixture.integration_enabled == true
    and .[0].fixture.outbox_id == $outbox
    and .[0].fixture.artist_id == $artist
    and .[0].fixture.enquiry_id == $enquiry
    and .[0].fixture.email_domain == "example.invalid"
    and .[0].fixture.intake_state == "complete"
    and .[0].fixture.file_count == 1
    and .[0].fixture.ready_file_count == 1
    and .[0].fixture.status == "failed"
    and .[0].fixture.attempt_count == 1
    and .[0].fixture.max_attempts == 8
    and .[0].fixture.due == true
    and .[0].fixture.last_error_code == "synthetic_retry_setup"
    and .[0].fixture.lease_clear == true
    and .[0].fixture.validation_marker == $marker
  ' "$raw_file" >/dev/null || die "synthetic Kristina fixture setup was not exact"
  jq -S '.[0].fixture' "$raw_file" > "${EVIDENCE_DIR}/target-before.json"
  rm -f "$sql_file" "$raw_file"

  write_snapshot after-setup
  verify_historical_shape "${EVIDENCE_DIR}/after-setup.json"
  diff -u \
    <(jq -S '.historical' "${EVIDENCE_DIR}/before.json") \
    <(jq -S '.historical' "${EVIDENCE_DIR}/after-setup.json") >/dev/null \
    || die "a historical Telegram failure changed during setup"
  diff -u \
    <(jq -S '.telegram_rows' "${EVIDENCE_DIR}/before.json") \
    <(jq -S --arg target "$TARGET_OUTBOX_ID" '[.telegram_rows[] | select(.id != $target)]' \
      "${EVIDENCE_DIR}/after-setup.json") >/dev/null \
    || die "a pre-existing Telegram job changed during setup"
  jq -e --arg artist "$KRISTINA_ARTIST_ID" --arg target "$TARGET_OUTBOX_ID" '
    .latest_migration == "0035"
    and .telegram_counts == {succeeded:9, failed:8, pending:0, leased:0, dead:0, total:17}
    and any(.telegram_rows[];
      .id == $target and .artist_id == $artist and .status == "failed"
      and .attempt_count == 1
    )
    and .kristina_booking_source.is_active == false
    and .kristina_booking_source.allowed_origin == null
  ' "${EVIDENCE_DIR}/after-setup.json" >/dev/null \
    || die "setup changed state outside one Kristina target and route"
}

prepare_exact_target() {
  if [ "$BASELINE_MODE" = 'fresh' ]; then
    create_route_and_one_fixture
    return
  fi
  jq -S --arg target "$TARGET_OUTBOX_ID" '
    .telegram_rows[] | select(.id == $target) |
    {
      outbox_id:.id, artist_id, enquiry_id, status, attempt_count,
      max_attempts, due:true, last_error_code,
      lease_clear:(.leased_by == null and .leased_at == null and .lease_expires_at == null)
    }
  ' "${EVIDENCE_DIR}/before.json" > "${EVIDENCE_DIR}/target-before.json"
}

run_exact_kristina_drain() {
  local binding_file
  binding_file="$(mktemp "${RUNNER_TEMP}/kristina-provider-binding.XXXXXX.json")"
  chmod 600 "$binding_file"
  jq -n --arg bot "$KRISTINA_TELEGRAM_BOT_TOKEN" --arg chat "$KRISTINA_TELEGRAM_CHAT_ID" \
    '{botToken:$bot,chatId:$chat}' > "$binding_file"

  [ -z "${ARTIST_TELEGRAM_VLADIMIR_HSTAGING:-}" ] \
    || die "Vladimir Telegram binding must not be present in the Kristina runtime"
  export ARTIST_TELEGRAM_KRISTINA_HSTAGING
  ARTIST_TELEGRAM_KRISTINA_HSTAGING="$(jq -c . "$binding_file")"
  rm -f "$binding_file"
  unset KRISTINA_TELEGRAM_BOT_TOKEN KRISTINA_TELEGRAM_CHAT_ID
  unset TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID

  export TARGET_OUTBOX_ID
  export TELEGRAM_WORKER_ID="telegram-kristina-parity-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
  export DRAIN_EVIDENCE_PATH="${EVIDENCE_DIR}/drain-result.json"
  node scripts/run-kristina-telegram-parity.mjs
  unset ARTIST_TELEGRAM_KRISTINA_HSTAGING TELEGRAM_WORKER_ID DRAIN_EVIDENCE_PATH
}

verify_post_state() {
  local sql_file raw_file
  sql_file="${RUNNER_TEMP}/kristina-target-after.sql"
  raw_file="${RUNNER_TEMP}/kristina-target-after.raw.json"
  cat > "$sql_file" <<SQL
select jsonb_build_object(
  'outbox_id', o.id,
  'artist_id', o.artist_id,
  'enquiry_id', o.enquiry_id,
  'status', o.status,
  'attempt_count', o.attempt_count,
  'last_error_code', o.last_error_code,
  'lease_clear', o.leased_by is null and o.leased_at is null and o.lease_expires_at is null,
  'integration_key', i.integration_key,
  'success_activity_count', count(a.id) filter (where a.event_type = 'outbox.succeeded'),
  'failed_activity_count', count(a.id) filter (where a.event_type = 'outbox.failed'),
  'lease_aware_success', bool_or(
    a.event_type = 'outbox.succeeded'
    and a.metadata ->> 'lease_aware' = 'true'
    and a.metadata ->> 'attempt_count' = '$EXPECTED_AFTER_ATTEMPT'
  ),
  'activity_relationship_valid', bool_and(
    a.outbox_id = o.id and a.enquiry_id = o.enquiry_id
  ) filter (where a.event_type = 'outbox.succeeded')
) as target
from public.integration_outbox o
join public.artist_integrations i
  on i.artist_id = o.artist_id and i.integration_type = 'telegram' and i.is_enabled
left join public.activity_log a on a.outbox_id = o.id
where o.id = '$TARGET_OUTBOX_ID'::uuid
group by o.id, o.artist_id, o.enquiry_id, o.status, o.attempt_count,
         o.last_error_code, o.leased_by, o.leased_at, o.lease_expires_at,
         i.integration_key;
SQL
  sql "$sql_file" "$raw_file"
  jq -e \
    --arg outbox "$TARGET_OUTBOX_ID" \
    --arg artist "$KRISTINA_ARTIST_ID" \
    --arg enquiry "$SYNTHETIC_ENQUIRY_ID" \
    --arg key "$KRISTINA_INTEGRATION_KEY" \
    --argjson expected_attempt "$EXPECTED_AFTER_ATTEMPT" \
    --argjson expected_failed_activity_count "$EXPECTED_FAILED_ACTIVITY_COUNT" '
    length == 1
    and .[0].target.outbox_id == $outbox
    and .[0].target.artist_id == $artist
    and .[0].target.enquiry_id == $enquiry
    and .[0].target.status == "succeeded"
    and .[0].target.attempt_count == $expected_attempt
    and .[0].target.last_error_code == null
    and .[0].target.lease_clear == true
    and .[0].target.integration_key == $key
    and .[0].target.success_activity_count == 1
    and .[0].target.failed_activity_count == $expected_failed_activity_count
    and .[0].target.lease_aware_success == true
    and .[0].target.activity_relationship_valid == true
  ' "$raw_file" >/dev/null || die "Kristina target acknowledgement evidence is invalid"
  jq -S '.[0].target' "$raw_file" > "${EVIDENCE_DIR}/target-after.json"
  rm -f "$sql_file" "$raw_file"

  write_snapshot after
  verify_historical_shape "${EVIDENCE_DIR}/after.json"
  diff -u \
    <(jq -S '.historical' "${EVIDENCE_DIR}/before.json") \
    <(jq -S '.historical' "${EVIDENCE_DIR}/after.json") >/dev/null \
    || die "a historical Vladimir failure changed"
  diff -u \
    <(jq -S --arg target "$TARGET_OUTBOX_ID" '[.telegram_rows[] | select(.id != $target)]' \
      "${EVIDENCE_DIR}/before.json") \
    <(jq -S --arg target "$TARGET_OUTBOX_ID" '[.telegram_rows[] | select(.id != $target)]' \
      "${EVIDENCE_DIR}/after.json") >/dev/null \
    || die "a pre-existing Vladimir Telegram job changed"
  if [ "$BASELINE_MODE" = 'fresh' ]; then
    diff -u \
      <(jq -S '.integrations' "${EVIDENCE_DIR}/before.json") \
      <(jq -S --arg integration "$KRISTINA_INTEGRATION_ID" \
        '[.integrations[] | select(.id != $integration)]' "${EVIDENCE_DIR}/after.json") >/dev/null \
      || die "a pre-existing artist integration changed"
  else
    diff -u \
      <(jq -S '.integrations' "${EVIDENCE_DIR}/before.json") \
      <(jq -S '.integrations' "${EVIDENCE_DIR}/after.json") >/dev/null \
      || die "an artist integration changed during recovery"
  fi
  diff -u \
    <(jq -S '.kristina_booking_source' "${EVIDENCE_DIR}/before.json") \
    <(jq -S '.kristina_booking_source' "${EVIDENCE_DIR}/after.json") >/dev/null \
    || die "Kristina booking source changed"
  jq -e \
    --arg vladimir "$VLADIMIR_ARTIST_ID" \
    --arg kristina "$KRISTINA_ARTIST_ID" \
    --arg target "$TARGET_OUTBOX_ID" \
    --arg integration "$KRISTINA_INTEGRATION_ID" \
    --argjson expected_attempt "$EXPECTED_AFTER_ATTEMPT" '
    .latest_migration == "0035"
    and .telegram_counts == {succeeded:10, failed:7, pending:0, leased:0, dead:0, total:17}
    and any(.telegram_by_artist[];
      .artist_id == $vladimir and .status == "succeeded" and .count == 9
    )
    and any(.telegram_by_artist[];
      .artist_id == $vladimir and .status == "failed" and .count == 7
    )
    and any(.telegram_by_artist[];
      .artist_id == $kristina and .status == "succeeded" and .count == 1
    )
    and any(.telegram_rows[];
      .id == $target and .artist_id == $kristina
      and .status == "succeeded" and .attempt_count == $expected_attempt
      and .last_error_code == null and .leased_by == null
      and .leased_at == null and .lease_expires_at == null
    )
    and any(.integrations[];
      .id == $integration and .artist_id == $kristina
      and .integration_type == "telegram" and .provider == "telegram"
      and .integration_key == "kristina-staging" and .is_enabled == true
    )
    and .kristina_booking_source.is_active == false
    and .kristina_booking_source.allowed_origin == null
  ' "${EVIDENCE_DIR}/after.json" >/dev/null \
    || die "final retained-staging parity state is incorrect"

  verify_project_health after
  npm run scan:secrets | tee "${EVIDENCE_DIR}/final-secret-scan.txt"
  jq -n \
    --arg head_sha "${APPROVED_SHA:?}" \
    --arg outbox_id "$TARGET_OUTBOX_ID" \
    --arg integration_key "$KRISTINA_INTEGRATION_KEY" \
    --arg binding_name "$KRISTINA_BINDING" \
    --arg baseline_mode "$BASELINE_MODE" \
    --argjson before_attempt "$EXPECTED_BEFORE_ATTEMPT" \
    --argjson after_attempt "$EXPECTED_AFTER_ATTEMPT" '
    {
      project_ref:"gwaliusblwrzisrwnsvs",
      migration_latest:"0035",
      head_sha:$head_sha,
      integration_key:$integration_key,
      binding_name:$binding_name,
      baseline_mode:$baseline_mode,
      target_outbox_id:$outbox_id,
      target_before:{status:"failed",attempt_count:$before_attempt},
      target_after:{status:"succeeded",attempt_count:$after_attempt,last_error_code:null,lease_clear:true},
      provider_accepted:true,
      activity_log_success_count:1,
      prior_failed_activity_count:($before_attempt - 1),
      historical_seven_unchanged:true,
      all_preexisting_vladimir_jobs_unchanged:true,
      vladimir_integration_unchanged:true,
      kristina_booking_source_inactive:true,
      kristina_allowed_origin_null:true,
      public_kristina_intake_deployed:false,
      automatic_drain_deployed:false,
      production_targeted:false,
      secret_scan:"passed"
    }
  ' > "${EVIDENCE_DIR}/summary.json"
}

for name in SUPABASE_ACCESS_TOKEN STAGING_SUPABASE_URL SUPABASE_SECRET_KEY \
  KRISTINA_TELEGRAM_BOT_TOKEN KRISTINA_TELEGRAM_CHAT_ID APPROVED_SHA; do
  require_env "$name"
done
[ "$STAGING_SUPABASE_URL" = "$STAGING_ORIGIN" ] || die "Supabase target is not retained staging"
case "$SUPABASE_SECRET_KEY" in sb_secret_*) ;; *) die "unexpected Supabase backend key format" ;; esac
[ "${PRODUCTION_TARGETED:-false}" = 'false' ] || die "production target must remain false"

verify_baseline
prepare_exact_target
run_exact_kristina_drain
verify_post_state

echo "Kristina exact-ID Telegram parity E2E succeeded for ${TARGET_OUTBOX_ID}"
