#!/usr/bin/env bash
set -euo pipefail

# Continuation-only hosted E2E for retained PR #177 staging.
# Preconditions are enforced by the guarded review-triggered workflow.
# This script never runs migrations, resets or seed, never targets production,
# and never selects or prints credential values.

readonly PROJECT_REF="gwaliusblwrzisrwnsvs"
readonly WORKER_NAME="tattooai-preview"
readonly WORKER_URL="https://intake-staging.vishartattoo.com/__vishar-staging-intake-2026"
readonly WORKER_HOST="intake-staging.vishartattoo.com"
readonly WORKER_PATH="/__vishar-staging-intake-2026"
readonly BOOKING_ORIGIN="https://vishar-booking-staging.pages.dev"
readonly BOOKING_DOMAIN="vishar-booking-staging.pages.dev"
readonly CRM_ORIGIN="https://vishar-crm-staging.pages.dev"
readonly CRM_DOMAIN="vishar-crm-staging.pages.dev"
readonly SOURCE_KEY="vladimir-staging"
readonly VLADIMIR_ID="a1111111-1111-4111-8111-111111111111"
readonly KRISTINA_ID="a2222222-2222-4222-8222-222222222222"
readonly ROUTE_KEY="vladimir-staging"
readonly ROUTE_BINDING="ARTIST_TELEGRAM_VLADIMIR_HSTAGING"

readonly MANAGER_ID="f1770000-0000-4000-8000-000000000001"
readonly READER_ID="f1770000-0000-4000-8000-000000000002"
readonly UNAUTH_ID="f1770000-0000-4000-8000-000000000003"
readonly DISABLED_ID="f1770000-0000-4000-8000-000000000004"
readonly SHARED_CLIENT_ID="c1770000-0000-4000-8000-000000000001"
readonly VLADIMIR_FIXTURE_ENQUIRY_ID="e1770000-0000-4000-8000-000000000001"
readonly KRISTINA_FIXTURE_ENQUIRY_ID="e1770000-0000-4000-8000-000000000002"
readonly VLADIMIR_FIXTURE_PROJECT_ID="b1770000-0000-4000-8000-000000000001"
readonly KRISTINA_FIXTURE_PROJECT_ID="b1770000-0000-4000-8000-000000000002"

readonly evidence_dir="${RUNNER_TEMP:?}/pr177-staging-evidence"
mkdir -p "$evidence_dir"

die() { echo "staging continuation E2E failed: $*" >&2; exit 1; }
require_env() { [ -n "${!1:-}" ] || die "required encrypted staging configuration $1 is unavailable"; }

sql() {
  local sql_file="$1" output_file="$2" request_file http_status
  request_file="$(mktemp "${RUNNER_TEMP}/pr177-continuation-sql.XXXXXX.json")"
  jq -Rs '{query: .}' < "$sql_file" > "$request_file"
  http_status="$(
    curl --silent --show-error \
      -o "$output_file" \
      -w '%{http_code}' \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data-binary "@$request_file" \
      "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"
  )"
  rm -f "$request_file"
  case "$http_status" in
    2??) ;;
    *) die "hosted SQL request returned HTTP $http_status" ;;
  esac
  jq -e '
    if type == "array" then true
    else ((.error // null) == null and (.result // null) != null)
    end
  ' "$output_file" >/dev/null || die "hosted SQL request failed"
}

sql_rows() {
  jq -c 'if type == "array" then . else .result end' "$1"
}

snapshot_database() {
  local target="$1"
  cat > "${RUNNER_TEMP}/pr177-continuation-snapshot.sql" <<'SQL'
select jsonb_build_object(
  'profiles', (select count(*) from public.profiles),
  'active_owners', (select count(*) from public.profiles where role='owner' and is_active),
  'active_managers', (select count(*) from public.profiles where role='booking_manager' and is_active),
  'active_read_only', (select count(*) from public.profiles where role='read_only' and is_active),
  'disabled_profiles', (select count(*) from public.profiles where not is_active),
  'clients', (select count(*) from public.clients),
  'enquiries', (select count(*) from public.enquiries),
  'projects', (select count(*) from public.projects),
  'file_manifests', (select count(*) from public.enquiry_files),
  'storage_objects', (select count(*) from storage.objects where bucket_id='crm-files'),
  'outbox', (select count(*) from public.integration_outbox),
  'activity', (select count(*) from public.activity_log),
  'references', coalesce((
    select jsonb_agg(reference_number order by reference_number)
    from public.enquiries
  ), '[]'::jsonb)
) as snapshot;
SQL
  sql "${RUNNER_TEMP}/pr177-continuation-snapshot.sql" "${evidence_dir}/${target}"
}

multipart_submit() {
  local key="$1" label="$2" output="$3"
  curl --fail-with-body --silent --show-error \
    -H "Origin: $BOOKING_ORIGIN" \
    -F "idempotencyKey=$key" \
    -F "name=PR177 Synthetic $label" \
    -F "email=pr177-${GITHUB_RUN_ID}-${label,,}@example.invalid" \
    -F 'phone=' \
    -F 'instagram=' \
    -F 'preferredReply=Email' \
    -F 'travellingFrom=London' \
    -F 'projectType=Colour realism' \
    -F 'placement=Outer forearm' \
    -F 'size=20 cm' \
    -F 'coverUp=No' \
    -F 'timing=Flexible' \
    -F 'idea=Synthetic hosted staging routing validation.' \
    -F 'website=' \
    -F 'source=/booking/' \
    -F "landingPage=$BOOKING_ORIGIN/booking/" \
    -F 'referrer=' \
    -F 'utmSource=pr177-staging' \
    -F 'utmMedium=synthetic' \
    -F 'privacyAcknowledged=true' \
    -F 'privacyNoticeVersion=2026-07-29' \
    -F "artist_id=$KRISTINA_ID" \
    -F 'integration_key=kristina-staging' \
    -F 'provider_account=forbidden-browser-route' \
    -F 'payment_destination=forbidden-browser-route' \
    -F "references=@${RUNNER_TEMP}/synthetic-reference.png;type=image/png" \
    "$WORKER_URL" > "$output"
  jq -e '.ok == true and (.reference | type == "string")' "$output" >/dev/null
}

database_e2e_assertions() {
  local positive_ref="$1" noroute_ref="$2"
  local routing_json positive_outbox_id positive_artist_id no_route_artist_id

  cat > "${RUNNER_TEMP}/pr177-database-assertions.sql" <<SQL
do \$block\$
declare
  p record;
  n record;
begin
  select e.id, e.artist_id, e.booking_source_id, e.intake_state
    into p
  from public.enquiries e
  where e.reference_number = '$positive_ref';

  select e.id, e.artist_id, e.booking_source_id, e.intake_state
    into n
  from public.enquiries e
  where e.reference_number = '$noroute_ref';

  if p.id is null or n.id is null then
    raise exception 'routed enquiry rows are missing';
  end if;
  if p.intake_state <> 'complete' or n.intake_state <> 'complete' then
    raise exception 'a routed enquiry did not remain complete';
  end if;
  if p.artist_id <> '$VLADIMIR_ID' or n.artist_id <> '$VLADIMIR_ID' then
    raise exception 'browser artist route influenced intake';
  end if;
  if not exists (
    select 1 from public.booking_sources s
    where s.id = p.booking_source_id and s.source_key = '$SOURCE_KEY'
  ) then
    raise exception 'positive trusted source mismatch';
  end if;
  if not exists (
    select 1 from public.booking_sources s
    where s.id = n.booking_source_id and s.source_key = '$SOURCE_KEY'
  ) then
    raise exception 'no-route trusted source mismatch';
  end if;
  if (select count(*) from public.enquiry_files f where f.enquiry_id=p.id and f.upload_state='ready') <> 1 then
    raise exception 'positive Storage manifest mismatch';
  end if;
  if (select count(*) from public.enquiry_files f where f.enquiry_id=n.id and f.upload_state='ready') <> 1 then
    raise exception 'no-route Storage manifest mismatch';
  end if;
  if (select count(*)
      from public.enquiry_files f
      join storage.objects o
        on o.bucket_id='crm-files' and o.name=f.storage_path
      where f.enquiry_id=p.id and f.upload_state='ready') <> 1 then
    raise exception 'positive private Storage object mismatch';
  end if;
  if (select count(*)
      from public.enquiry_files f
      join storage.objects o
        on o.bucket_id='crm-files' and o.name=f.storage_path
      where f.enquiry_id=n.id and f.upload_state='ready') <> 1 then
    raise exception 'no-route private Storage object mismatch';
  end if;
  if not exists (
    select 1 from public.integration_outbox o
    where o.enquiry_id=p.id and o.artist_id='$VLADIMIR_ID'
      and o.status='succeeded' and o.attempt_count=1
      and o.last_error_code is null
  ) then
    raise exception 'positive provider attempt mismatch';
  end if;
  if not exists (
    select 1 from public.integration_outbox o
    where o.enquiry_id=n.id and o.artist_id='$VLADIMIR_ID'
      and o.status='failed' and o.attempt_count=1
      and o.last_error_code='provider_route_unavailable'
  ) then
    raise exception 'no-route fail-closed outcome mismatch';
  end if;
  if not exists (
    select 1 from public.activity_log a
    where a.enquiry_id=p.id and a.artist_id='$VLADIMIR_ID'
  ) then
    raise exception 'positive activity artist mismatch';
  end if;
  if not exists (
    select 1 from public.activity_log a
    where a.enquiry_id=n.id and a.artist_id='$VLADIMIR_ID'
  ) then
    raise exception 'no-route activity artist mismatch';
  end if;
end
\$block\$;

-- Resolve all table-backed evidence while still privileged. The service_role
-- section below receives only the already resolved outbox UUID and artist UUIDs.
select jsonb_build_object(
  'positive_outbox_id', (
    select o.id
    from public.integration_outbox o
    join public.enquiries e on e.id=o.enquiry_id
    where e.reference_number='$positive_ref'
    order by o.created_at desc
    limit 1
  ),
  'positive_artist', (
    select e.artist_id from public.enquiries e
    where e.reference_number='$positive_ref'
  ),
  'no_route_artist', (
    select e.artist_id from public.enquiries e
    where e.reference_number='$noroute_ref'
  )
) as routing_ids;
SQL
  sql "${RUNNER_TEMP}/pr177-database-assertions.sql" "${evidence_dir}/routing-ids.json"

  routing_json="$(sql_rows "${evidence_dir}/routing-ids.json" | jq -c 'map(select(.routing_ids != null))[0].routing_ids // empty')"
  [ -n "$routing_json" ] || die "pre-role routing evidence was absent"
  positive_outbox_id="$(jq -r '.positive_outbox_id // empty' <<<"$routing_json")"
  positive_artist_id="$(jq -r '.positive_artist // empty' <<<"$routing_json")"
  no_route_artist_id="$(jq -r '.no_route_artist // empty' <<<"$routing_json")"
  [[ "$positive_outbox_id" =~ ^[0-9a-f-]{36}$ ]] || die "positive outbox id was invalid"
  [ "$positive_artist_id" = "$VLADIMIR_ID" ] || die "positive artist id changed before route resolution"
  [ "$no_route_artist_id" = "$VLADIMIR_ID" ] || die "no-route artist id changed before route resolution"

  cat > "${RUNNER_TEMP}/pr177-service-route-evidence.sql" <<SQL
set role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select jsonb_build_object(
  'positive_reference','$positive_ref',
  'no_route_reference','$noroute_ref',
  'positive_route',(
    select to_jsonb(r) - 'configuration'
    from public.resolve_outbox_route('$positive_outbox_id'::uuid) r
  ),
  'positive_artist','$positive_artist_id'::uuid,
  'no_route_artist','$no_route_artist_id'::uuid
) as routing_evidence;
reset role;
SQL
  sql "${RUNNER_TEMP}/pr177-service-route-evidence.sql" "${evidence_dir}/routing-evidence.json"
  jq -e --arg artist "$VLADIMIR_ID" --arg key "$ROUTE_KEY" '
    (if type == "array" then . else .result end)
    | map(select(.routing_evidence != null))[0].routing_evidence
    | .positive_artist == $artist
      and .no_route_artist == $artist
      and .positive_route.artist_id == $artist
      and .positive_route.provider == "telegram"
      and .positive_route.integration_type == "telegram"
      and .positive_route.integration_key == $key
      and (.positive_route.configuration == null)
  ' "${evidence_dir}/routing-evidence.json" >/dev/null \
    || die "service_role route evidence mismatch"
}

role_scope_assertions() {
  cat > "${RUNNER_TEMP}/pr177-role-scope.sql" <<SQL
do \$block\$
declare
  v_owner uuid;
begin
  select p.id into v_owner
  from public.profiles p
  where p.role='owner' and p.is_active
  order by p.id
  limit 1;
  if v_owner is null then
    raise exception 'existing active owner profile is required';
  end if;

  insert into auth.users (id,email) values
    ('$MANAGER_ID','pr177-manager@example.invalid'),
    ('$READER_ID','pr177-readonly@example.invalid'),
    ('$UNAUTH_ID','pr177-unauthorised@example.invalid'),
    ('$DISABLED_ID','pr177-disabled@example.invalid')
  on conflict (id) do nothing;

  delete from public.artist_memberships where profile_id='$UNAUTH_ID';
  delete from public.profiles where id='$UNAUTH_ID';

  insert into public.profiles (id,email,display_name,role,is_active) values
    ('$MANAGER_ID','pr177-manager@example.invalid','PR177 Synthetic Manager','booking_manager',true),
    ('$READER_ID','pr177-readonly@example.invalid','PR177 Synthetic Read Only','read_only',true),
    ('$DISABLED_ID','pr177-disabled@example.invalid','PR177 Synthetic Disabled','booking_manager',true)
  on conflict (id) do update
  set email=excluded.email,
      display_name=excluded.display_name,
      role=excluded.role,
      is_active=true;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub',v_owner,'role','authenticated')::text,
    true
  );

  perform public.upsert_artist_membership(
    '$MANAGER_ID','$VLADIMIR_ID','manager',true,false,true,true,true
  );
  perform public.upsert_artist_membership(
    '$MANAGER_ID','$KRISTINA_ID','manager',false,false,true,false,false
  );
  perform public.upsert_artist_membership(
    '$READER_ID','$VLADIMIR_ID','read_only',false,false,false,false,true
  );
  perform public.upsert_artist_membership(
    '$READER_ID','$KRISTINA_ID','read_only',false,false,false,false,false
  );
  perform public.upsert_artist_membership(
    '$DISABLED_ID','$VLADIMIR_ID','manager',false,false,true,false,true
  );

  -- Exercise the normal audited owner RPC for the disabled fixture.
  perform public.set_profile_active('$DISABLED_ID',false);

  insert into public.clients (id,full_name,email)
  values ('$SHARED_CLIENT_ID','PR177 Shared Synthetic Client','pr177-shared-client@example.invalid')
  on conflict (id) do nothing;

  insert into public.enquiries (
    id,client_id,reference_number,idempotency_key,intake_fingerprint,
    intake_state,submitted_full_name,submitted_email,idea,source,
    privacy_notice_version,privacy_acknowledged_at,artist_id
  ) values
    ('$VLADIMIR_FIXTURE_ENQUIRY_ID','$SHARED_CLIENT_ID','placeholder',
     '71770000-0000-4000-8000-000000000001',repeat('c',64),
     'complete','PR177 Shared Synthetic Client','pr177-shared-client@example.invalid',
     'Synthetic Vladimir scope fixture','pr177-hosted-e2e','2026-07-29',now(),'$VLADIMIR_ID'),
    ('$KRISTINA_FIXTURE_ENQUIRY_ID','$SHARED_CLIENT_ID','placeholder',
     '72770000-0000-4000-8000-000000000002',repeat('d',64),
     'complete','PR177 Shared Synthetic Client','pr177-shared-client@example.invalid',
     'Synthetic Kristina scope fixture','pr177-hosted-e2e','2026-07-29',now(),'$KRISTINA_ID')
  on conflict (id) do nothing;

  insert into public.projects (
    id,client_id,enquiry_id,status,title,
    hourly_rate,estimate_total,currency,artist_id
  ) values
    ('$VLADIMIR_FIXTURE_PROJECT_ID','$SHARED_CLIENT_ID','$VLADIMIR_FIXTURE_ENQUIRY_ID',
     'active','PR177 Vladimir Finance Fixture',140.00,980.00,'GBP','$VLADIMIR_ID'),
    ('$KRISTINA_FIXTURE_PROJECT_ID','$SHARED_CLIENT_ID','$KRISTINA_FIXTURE_ENQUIRY_ID',
     'active','PR177 Kristina Finance Fixture',150.00,1050.00,'GBP','$KRISTINA_ID')
  on conflict (id) do nothing;
end
\$block\$;

begin;
create temporary table pr177_owner_fixture on commit drop as
select p.id as owner_id
from public.profiles p
where p.role='owner' and p.is_active
order by p.id
limit 1;

create function pg_temp.readonly_mutation_denied(p_enquiry_id uuid)
returns boolean
language plpgsql
as \$fn\$
begin
  begin
    perform public.transition_enquiry_status(p_enquiry_id,'reviewing');
    return false;
  exception when sqlstate '42501' then
    return true;
  end;
end
\$fn\$;

grant select on pr177_owner_fixture to authenticated;
grant execute on function pg_temp.readonly_mutation_denied(uuid) to authenticated;
set local role authenticated;

do \$block\$
declare
  v_owner uuid;
  v_count integer;
  v_denied boolean;
begin
  select owner_id into v_owner from pr177_owner_fixture;
  if v_owner is null then raise exception 'owner fixture lookup failed'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 2 then raise exception 'owner combined artist view mismatch'; end if;
  select count(*) into v_count from public.enquiries
  where id in ('$VLADIMIR_FIXTURE_ENQUIRY_ID','$KRISTINA_FIXTURE_ENQUIRY_ID');
  if v_count <> 2 then raise exception 'owner combined enquiry view mismatch'; end if;
  select count(*) into v_count from public.projects_finance
  where id in ('$VLADIMIR_FIXTURE_PROJECT_ID','$KRISTINA_FIXTURE_PROJECT_ID');
  if v_count <> 2 then raise exception 'owner separate artist finance view mismatch'; end if;
  select count(*) into v_count from public.clients where id='$SHARED_CLIENT_ID';
  if v_count <> 1 then raise exception 'owner shared client view mismatch'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub','$MANAGER_ID','role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 1 or not public.can_access_artist('$VLADIMIR_ID')
     or public.can_access_artist('$KRISTINA_ID') then
    raise exception 'manager accessible artist options mismatch';
  end if;
  if not exists(select 1 from public.enquiries where id='$VLADIMIR_FIXTURE_ENQUIRY_ID') then
    raise exception 'manager cannot see assigned Vladimir enquiry';
  end if;
  if exists(select 1 from public.enquiries where id='$KRISTINA_FIXTURE_ENQUIRY_ID') then
    raise exception 'manager crossed into unassigned Kristina enquiry';
  end if;
  if not exists(select 1 from public.clients where id='$SHARED_CLIENT_ID') then
    raise exception 'manager cannot see shared client through assigned artist';
  end if;
  if not exists(select 1 from public.projects_finance where id='$VLADIMIR_FIXTURE_PROJECT_ID') then
    raise exception 'manager Vladimir finance scope missing';
  end if;
  if exists(select 1 from public.projects_finance where id='$KRISTINA_FIXTURE_PROJECT_ID') then
    raise exception 'manager crossed into Kristina finance scope';
  end if;

  -- Verify a live grant and revoke without leaving the manager cross-assigned.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'role','authenticated')::text,true);
  perform public.upsert_artist_membership(
    '$MANAGER_ID','$KRISTINA_ID','manager',false,false,true,false,true
  );
  perform set_config('request.jwt.claims',jsonb_build_object('sub','$MANAGER_ID','role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 2 or not exists(
    select 1 from public.enquiries where id='$KRISTINA_FIXTURE_ENQUIRY_ID'
  ) then
    raise exception 'manager artist grant was not reflected by RLS';
  end if;
  if exists(select 1 from public.projects_finance where id='$KRISTINA_FIXTURE_PROJECT_ID') then
    raise exception 'manager grant widened finance without finance capability';
  end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'role','authenticated')::text,true);
  perform public.upsert_artist_membership(
    '$MANAGER_ID','$KRISTINA_ID','manager',false,false,true,false,false
  );
  perform set_config('request.jwt.claims',jsonb_build_object('sub','$MANAGER_ID','role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 1 or exists(
    select 1 from public.enquiries where id='$KRISTINA_FIXTURE_ENQUIRY_ID'
  ) then
    raise exception 'manager revoked artist scope remained visible';
  end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub','$READER_ID','role','authenticated')::text,true);
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 1 or not public.can_access_artist('$VLADIMIR_ID')
     or public.can_access_artist('$KRISTINA_ID') then
    raise exception 'read_only accessible artist options mismatch';
  end if;
  if not exists(select 1 from public.enquiries where id='$VLADIMIR_FIXTURE_ENQUIRY_ID')
     or exists(select 1 from public.enquiries where id='$KRISTINA_FIXTURE_ENQUIRY_ID') then
    raise exception 'read_only artist row scope mismatch';
  end if;
  select pg_temp.readonly_mutation_denied('$VLADIMIR_FIXTURE_ENQUIRY_ID') into v_denied;
  if not v_denied then raise exception 'read_only mutation unexpectedly succeeded'; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub','$UNAUTH_ID','role','authenticated')::text,true);
  if public.is_active_user() then raise exception 'unauthorised Auth fixture became active'; end if;
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 0 then raise exception 'unauthorised Auth fixture received artist options'; end if;
  if exists(select 1 from public.clients where id='$SHARED_CLIENT_ID')
     or exists(select 1 from public.enquiries where id in ('$VLADIMIR_FIXTURE_ENQUIRY_ID','$KRISTINA_FIXTURE_ENQUIRY_ID')) then
    raise exception 'unauthorised Auth fixture crossed CRM RLS';
  end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub','$DISABLED_ID','role','authenticated')::text,true);
  if public.is_active_user() then raise exception 'disabled profile remained active'; end if;
  select count(*) into v_count from public.list_accessible_artists();
  if v_count <> 0 then raise exception 'disabled profile received artist options'; end if;
  if exists(select 1 from public.clients where id='$SHARED_CLIENT_ID')
     or exists(select 1 from public.enquiries where id in ('$VLADIMIR_FIXTURE_ENQUIRY_ID','$KRISTINA_FIXTURE_ENQUIRY_ID')) then
    raise exception 'disabled profile crossed CRM RLS';
  end if;
end
\$block\$;
commit;

select jsonb_build_object(
  'owner_reused',true,
  'owner_accessible_artists',2,
  'owner_combined_view','passed',
  'manager_assigned_artist','vladimir',
  'manager_unassigned_artist_rows',0,
  'manager_dynamic_grant_revoke','passed',
  'read_only_mutation_denial','passed',
  'unauthorised_auth_without_profile','passed',
  'disabled_profile','passed',
  'accessible_selector_options_only','passed',
  'all_assigned_artists_wording','covered by hosted UI tests in EN and RU',
  'stale_persisted_selection_reset','covered by hosted UI tests',
  'shared_clients','passed',
  'separate_artist_finance','passed'
) as role_evidence;
SQL
  sql "${RUNNER_TEMP}/pr177-role-scope.sql" "${evidence_dir}/crm-role-scope-evidence.json"
}

edge_assertions() {
  local api zone_id booking_app_id crm_app_id code limited
  local booking_policy_file crm_policy_file
  local auth_headers=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
  api='https://api.cloudflare.com/client/v4'

  [ "$PROJECT_REF" = 'gwaliusblwrzisrwnsvs' ] || die "database target is not retained staging"
  [ "$WORKER_URL" = "https://${WORKER_HOST}${WORKER_PATH}" ] || die "Worker target mismatch"
  [[ "$BOOKING_DOMAIN" == *-staging.pages.dev ]] || die "booking target is not staging"
  [[ "$CRM_DOMAIN" == *-staging.pages.dev ]] || die "CRM target is not staging"

  code="$(curl --silent --show-error -D "${evidence_dir}/booking-access.headers" -o /dev/null -w '%{http_code}' "$BOOKING_ORIGIN/booking/")"
  case "$code" in 301|302|303|307|308) ;; *) die "Booking Pages was not Access-gated: HTTP $code";; esac
  grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/booking-access.headers" \
    || die "Booking Pages did not redirect to Cloudflare Access"

  code="$(curl --silent --show-error -D "${evidence_dir}/crm-access.headers" -o /dev/null -w '%{http_code}' "$CRM_ORIGIN/")"
  case "$code" in 301|302|303|307|308) ;; *) die "CRM Pages was not Access-gated: HTTP $code";; esac
  grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/crm-access.headers" \
    || die "CRM Pages did not redirect to Cloudflare Access"

  code="$(curl --silent --show-error -D "${evidence_dir}/trusted-preflight.headers" -o /dev/null -w '%{http_code}' \
    -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 204 ] || die "trusted CORS preflight was HTTP $code"
  grep -Fqi "access-control-allow-origin: $BOOKING_ORIGIN" "${evidence_dir}/trusted-preflight.headers" \
    || die "trusted preflight lacked the exact staging allow-origin"
  ! grep -Eqi '^location: .*cloudflareaccess' "${evidence_dir}/trusted-preflight.headers" \
    || die "Cloudflare Access is incorrectly in front of the intake Worker"

  code="$(curl --silent --show-error -D "${evidence_dir}/invalid-preflight.headers" \
    -o "${evidence_dir}/invalid-origin.json" -w '%{http_code}' \
    -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 403 ] || die "wrong Origin was not rejected: HTTP $code"
  ! grep -Eqi '^access-control-allow-origin:' "${evidence_dir}/invalid-preflight.headers" \
    || die "wrong Origin received an allow-origin header"

  code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X GET "$WORKER_URL")"
  [ "$code" = 403 ] || die "WAF did not block GET on the intake path: HTTP $code"
  code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X OPTIONS \
    -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' \
    "https://${WORKER_HOST}/__pr177-wrong-path")"
  [ "$code" = 403 ] || die "WAF did not block OPTIONS on a wrong path: HTTP $code"
  code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X POST \
    -H "Origin: $BOOKING_ORIGIN" "https://${WORKER_HOST}/__pr177-wrong-path")"
  [ "$code" = 403 ] || die "WAF did not block POST on a wrong path: HTTP $code"

  zone_id="$(curl --silent --show-error "${auth_headers[@]}" "$api/zones?name=vishartattoo.com" | jq -r '.result[0].id // empty')"
  [ -n "$zone_id" ] || die "staging Cloudflare zone was unavailable"

  curl --silent --show-error "${auth_headers[@]}" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps?per_page=100" \
    > "${evidence_dir}/access-apps.json"
  jq -e '.success == true' "${evidence_dir}/access-apps.json" >/dev/null \
    || die "Cloudflare Access app query failed"
  jq -e --arg booking "$BOOKING_DOMAIN" --arg crm "$CRM_DOMAIN" '
    [.result[] | select(.domain == $booking or .domain == $crm)] | length == 2
  ' "${evidence_dir}/access-apps.json" >/dev/null \
    || die "both staging Pages Access apps were not found"
  jq -e --arg worker "$WORKER_HOST" '
    [.result[] | select(.domain == $worker or ((.domain // "") | startswith($worker + "/")))] | length == 0
  ' "${evidence_dir}/access-apps.json" >/dev/null \
    || die "an Access app is incorrectly attached to the intake Worker"

  booking_app_id="$(jq -r --arg domain "$BOOKING_DOMAIN" '.result[] | select(.domain==$domain) | .id' "${evidence_dir}/access-apps.json" | head -n1)"
  crm_app_id="$(jq -r --arg domain "$CRM_DOMAIN" '.result[] | select(.domain==$domain) | .id' "${evidence_dir}/access-apps.json" | head -n1)"
  [ -n "$booking_app_id" ] && [ -n "$crm_app_id" ] || die "staging Access app ids were absent"

  booking_policy_file="${RUNNER_TEMP}/pr177-booking-access-policies.json"
  crm_policy_file="${RUNNER_TEMP}/pr177-crm-access-policies.json"
  curl --silent --show-error "${auth_headers[@]}" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$booking_app_id/policies" > "$booking_policy_file"
  curl --silent --show-error "${auth_headers[@]}" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$crm_app_id/policies" > "$crm_policy_file"

  for policy_file in "$booking_policy_file" "$crm_policy_file"; do
    jq -e '
      .success == true
      and ([.result[] | select(.decision == "allow")] | length == 1)
      and ([.result[] | select(.decision == "bypass" or .decision == "service_auth")] | length == 0)
      and ([.result[] | select(.decision == "allow") | .include[]?] as $include
           | ($include | length) == 1
           and all($include[]; has("email")))
    ' "$policy_file" >/dev/null || die "a staging Pages Access policy was not owner-only"
  done
  rm -f "$booking_policy_file" "$crm_policy_file"

  curl --silent --show-error "${auth_headers[@]}" \
    "$api/zones/$zone_id/rulesets/phases/http_request_firewall_custom/entrypoint" \
    > "${evidence_dir}/waf.json"
  curl --silent --show-error "${auth_headers[@]}" \
    "$api/zones/$zone_id/rulesets/phases/http_ratelimit/entrypoint" \
    > "${evidence_dir}/rate-limit.json"
  curl --silent --show-error "${auth_headers[@]}" \
    "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/$WORKER_NAME/environments/production/subdomain" \
    > "${evidence_dir}/subdomain.json"

  jq -e --arg host "$WORKER_HOST" --arg path "$WORKER_PATH" '
    [.result.rules[]? | select(
      .enabled
      and ((.expression // "") | contains($host))
      and ((.expression // "") | contains($path))
      and ((.expression // "") | contains("POST"))
      and ((.expression // "") | contains("OPTIONS"))
    )] | length > 0
  ' "${evidence_dir}/waf.json" >/dev/null || die "exact staging WAF path/method rule was not found"
  jq -e --arg host "$WORKER_HOST" --arg path "$WORKER_PATH" '
    [.result.rules[]? | select(
      .enabled
      and ((.expression // "") | contains($host))
      and ((.expression // "") | contains($path))
    )] | length > 0
  ' "${evidence_dir}/rate-limit.json" >/dev/null || die "staging rate-limit rule was not found"
  jq -e '.result.enabled == false and .result.previews_enabled == false' \
    "${evidence_dir}/subdomain.json" >/dev/null || die "workers.dev or Worker previews are enabled"

  limited=false
  for _ in 1 2 3 4 5 6 7; do
    code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
      -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
    [ "$code" = 429 ] && limited=true
  done
  $limited || die "rate-limit probe did not observe HTTP 429"
  sleep 12
  code="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
    -X OPTIONS -H "Origin: $BOOKING_ORIGIN" -H 'Access-Control-Request-Method: POST' "$WORKER_URL")"
  [ "$code" = 204 ] || die "rate limit did not recover to HTTP 204"

  jq -n \
    --arg booking "$BOOKING_DOMAIN" \
    --arg crm "$CRM_DOMAIN" \
    --arg worker "$WORKER_HOST" \
    '{
      booking_access:{domain:$booking,owner_only:true},
      crm_access:{domain:$crm,owner_only:true},
      intake_worker:{domain:$worker,access:false,workers_dev:false},
      cors:{exact_staging_origin:true,wrong_origin_rejected:true},
      waf:{exact_path_and_methods:true,wrong_path_blocked:true,wrong_method_blocked:true},
      rate_limit:{observed_429:true,recovered:true},
      production_targeting:false
    }' > "${evidence_dir}/edge-evidence.json"
}

hosted_e2e() {
  require_env SUPABASE_ACCESS_TOKEN
  require_env CLOUDFLARE_API_TOKEN
  require_env CLOUDFLARE_ACCOUNT_ID
  [ -n "${GITHUB_SHA:-}" ] || die "GITHUB_SHA is unavailable"

  snapshot_database database-before-continuation.json

  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' \
    | base64 -d > "${RUNNER_TEMP}/synthetic-reference.png"

  local positive_key positive_ref noroute_key noroute_ref route_disabled
  positive_key="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  multipart_submit "$positive_key" Positive "${evidence_dir}/positive.json"
  positive_ref="$(jq -r '.reference' "${evidence_dir}/positive.json")"
  multipart_submit "$positive_key" Positive "${evidence_dir}/replay.json"
  [ "$(jq -r '.reference' "${evidence_dir}/replay.json")" = "$positive_ref" ] \
    || die "idempotent replay changed the positive reference"
  [ "$(jq -r '.replayed' "${evidence_dir}/replay.json")" = true ] \
    || die "idempotent replay was not reported"

  cat > "${RUNNER_TEMP}/pr177-disable-route.sql" <<SQL
update public.artist_integrations
set is_enabled=false
where artist_id='$VLADIMIR_ID'
  and integration_type='telegram'
  and integration_key='$ROUTE_KEY';
SQL
  sql "${RUNNER_TEMP}/pr177-disable-route.sql" "${evidence_dir}/route-disabled.json"
  route_disabled=true
  cleanup_route() {
    if $route_disabled; then
      cat > "${RUNNER_TEMP}/pr177-enable-route.sql" <<SQL
update public.artist_integrations
set is_enabled=true
where artist_id='$VLADIMIR_ID'
  and integration_type='telegram'
  and integration_key='$ROUTE_KEY';
SQL
      sql "${RUNNER_TEMP}/pr177-enable-route.sql" "${evidence_dir}/route-restored.json" || true
    fi
  }
  trap cleanup_route EXIT

  noroute_key="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  multipart_submit "$noroute_key" NoRoute "${evidence_dir}/no-route.json"
  noroute_ref="$(jq -r '.reference' "${evidence_dir}/no-route.json")"
  cleanup_route
  route_disabled=false
  trap - EXIT

  database_e2e_assertions "$positive_ref" "$noroute_ref"
  role_scope_assertions
  edge_assertions
  snapshot_database database-after-continuation.json

  jq -n \
    --arg sha "$GITHUB_SHA" \
    --arg positive "$positive_ref" \
    --arg noroute "$noroute_ref" \
    --arg worker "$WORKER_NAME" \
    --arg route_binding "$ROUTE_BINDING" \
    '{
      sha:$sha,
      positive_reference:$positive,
      no_route_reference:$noroute,
      pgtap_tests:933,
      lint:"error-level pass",
      worker:$worker,
      artist_binding:$route_binding,
      booking_pages:"vishar-booking-staging",
      crm_pages:"vishar-crm-staging",
      role_scope:"pass",
      edge_security:"pass",
      migrations:"0001-0025 retained; not rerun",
      production_targeting:false,
      retained:true
    }' > "${evidence_dir}/summary.json"
}

hosted_e2e
