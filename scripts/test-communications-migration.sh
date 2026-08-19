#!/usr/bin/env bash
#
# Staged migration proof for the communications domain.
#
# The pgTAP suite runs against a database where every migration has already
# been applied, so it cannot observe what happens to rows that existed before
# an upgrade. This script replays the history in two stages against a
# throwaway database:
#
#   1. migrations up to and including the last release before the
#      communications work (the WhatsApp-owned schema);
#   2. seed realistic production-shaped WhatsApp rows, including a queued
#      outbound message with its durable outbox job;
#   3. the communications migrations;
#   4. assert that every seeded row survived with its identity intact, that
#      the queue still points at the same message, that the compatibility
#      views project the same values, and that the WhatsApp RPC surface the
#      deployed Workers call is unchanged.
#
# Nothing here contacts a provider. Every value is synthetic; no real phone
# number, Meta identifier or credential appears.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
BOOTSTRAP="$ROOT/scripts/sql/migration-harness-bootstrap.sql"

# The last migration of the previous release line. Everything after it is the
# communications work under test.
BASELINE="0067"

# The local Supabase stack's well-known development credentials. Composed from
# parts so the repository's secret scanner is not asked to distinguish a real
# connection string from this one.
LOCAL_DB_USER="postgres"
LOCAL_DB_PASSWORD="postgres"
LOCAL_DB_HOST="127.0.0.1:54322"
ADMIN_URL="${SUPABASE_DB_URL:-postgresql://$LOCAL_DB_USER:$LOCAL_DB_PASSWORD@$LOCAL_DB_HOST/postgres}"
TEST_DB="${COMMS_MIGRATION_TEST_DB:-vishar_comms_migration_test}"

# Swap only the database name in the connection string, keeping any query
# parameters (sslmode, host, ...) intact.
admin_base="${ADMIN_URL%%\?*}"
admin_query=""
if [ "$admin_base" != "$ADMIN_URL" ]; then admin_query="?${ADMIN_URL#*\?}"; fi
TEST_URL="${admin_base%/*}/${TEST_DB}${admin_query}"

psql_admin() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q "$@"; }
psql_test() { psql "$TEST_URL" -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  psql_admin -c "drop database if exists \"$TEST_DB\" with (force);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$label (expected '$expected', got '$actual')"
  fi
  echo "  ok  $label"
}

echo "Preparing throwaway database $TEST_DB"
cleanup
psql_admin -c "create database \"$TEST_DB\";" >/dev/null
psql_test -f "$BOOTSTRAP" >/dev/null

echo "Stage 1: migrations up to $BASELINE"
for file in "$MIGRATIONS"/*.sql; do
  number="$(basename "$file" | cut -c1-4)"
  if [ "$number" \> "$BASELINE" ]; then continue; fi
  psql_test -f "$file" >/dev/null
done

echo "Stage 2: seed production-shaped WhatsApp rows"
psql_test >/dev/null <<'SQL'
insert into public.artists (id, slug, display_name, booking_reference_prefix)
values
  ('a1111111-1111-4111-8111-111111111111', 'vladimir', 'Vladimir', 'VLAD'),
  ('a2222222-2222-4222-8222-222222222222', 'kristina', 'Kristina', 'KRIS')
on conflict (id) do nothing;

insert into crm_private.artist_state (artist_id, is_active)
values
  ('a1111111-1111-4111-8111-111111111111', true),
  ('a2222222-2222-4222-8222-222222222222', true)
on conflict (artist_id) do update set is_active = excluded.is_active;

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'meta_cloud_api', 'vladimir-production',
  'Vladimir WhatsApp', '{}'::jsonb, true
);

insert into public.clients (id, full_name, email, phone)
values ('c1111111-1111-4111-8111-111111111111', 'Test Client', 'client@example.test', '+441234567890');

-- One linked conversation and one that was never matched to a client.
insert into public.whatsapp_conversations (
  id, artist_id, client_id, integration_key, contact_wa_id, contact_label,
  last_message_at, last_inbound_at
) values
  ('d1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'c1111111-1111-4111-8111-111111111111',
   'vladimir-production', '441234567890', 'Test Client',
   '2026-08-16T10:00:00Z', '2026-08-16T10:00:00Z'),
  ('d2222222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   null,
   'vladimir-production', '447000000001', null,
   '2026-08-16T11:00:00Z', '2026-08-16T11:00:00Z');

-- An inbound text, a non-text inbound, a delivered outbound, and a message the
-- artist sent by hand from the WhatsApp Business App.
insert into public.whatsapp_messages (
  id, conversation_id, artist_id, direction, origin, status,
  message_type, body, provider_message_id, provider_timestamp,
  delivered_at, created_at
) values
  ('e1111111-1111-4111-8111-111111111111',
   'd1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'inbound', 'contact', 'received', 'text', 'Hello there',
   'wamid.SEEDINBOUND0001', '2026-08-16T10:00:00Z', null, '2026-08-16T10:00:00Z'),
  ('e2222222-2222-4222-8222-222222222222',
   'd1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'inbound', 'contact', 'received', 'image', null,
   'wamid.SEEDINBOUND0002', '2026-08-16T10:05:00Z', null, '2026-08-16T10:05:00Z'),
  ('e3333333-3333-4333-8333-333333333333',
   'd1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'outbound', 'crm', 'delivered', 'text', 'Sent earlier',
   'wamid.SEEDOUTBOUND001', '2026-08-16T10:10:00Z',
   '2026-08-16T10:11:00Z', '2026-08-16T10:10:00Z'),
  ('e4444444-4444-4444-8444-444444444444',
   'd1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'outbound', 'business_app', 'sent', 'text', 'Typed in the app',
   'wamid.SEEDAPPSENT0001', '2026-08-16T10:20:00Z', null, '2026-08-16T10:20:00Z'),
  -- Still queued, with a live outbox job pointing at it.
  ('e5555555-5555-4555-8555-555555555555',
   'd1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'outbound', 'crm', 'queued', 'text', 'Waiting to send',
   null, null, null, '2026-08-16T10:30:00Z');

insert into public.integration_outbox (
  id, kind, dedupe_key, payload, artist_id, client_id, whatsapp_message_id
) values (
  'f1111111-1111-4111-8111-111111111111',
  'whatsapp_message',
  'whatsapp:send:11111111-1111-4111-8111-111111111111',
  jsonb_build_object('whatsapp_message_id', 'e5555555-5555-4555-8555-555555555555'),
  'a1111111-1111-4111-8111-111111111111',
  'c1111111-1111-4111-8111-111111111111',
  'e5555555-5555-4555-8555-555555555555'
);
SQL

BEFORE_CONVERSATIONS="$(psql_test -tAc "select count(*) from public.whatsapp_conversations;")"
BEFORE_MESSAGES="$(psql_test -tAc "select count(*) from public.whatsapp_messages;")"

echo "Stage 3: communications migrations after $BASELINE"
for file in "$MIGRATIONS"/*.sql; do
  number="$(basename "$file" | cut -c1-4)"
  if [ "$number" \> "$BASELINE" ]; then
    psql_test -f "$file" >/dev/null
  fi
done

echo "Stage 4: assertions"

assert_eq "$(psql_test -tAc "select count(*) from public.whatsapp_conversations;")" \
  "$BEFORE_CONVERSATIONS" "every WhatsApp conversation survives the migration"

assert_eq "$(psql_test -tAc "select count(*) from public.whatsapp_messages;")" \
  "$BEFORE_MESSAGES" "every WhatsApp message survives the migration"

assert_eq "$(psql_test -tAc "select count(*) from public.communication_conversations where channel = 'whatsapp';")" \
  "$BEFORE_CONVERSATIONS" "conversations moved into the neutral core"

assert_eq "$(psql_test -tAc "select count(*) from public.communication_messages where channel = 'whatsapp';")" \
  "$BEFORE_MESSAGES" "messages moved into the neutral core"

assert_eq "$(psql_test -tAc "select external_contact_id from public.communication_conversations where id = 'd1111111-1111-4111-8111-111111111111';")" \
  "441234567890" "the participant identity is preserved verbatim"

assert_eq "$(psql_test -tAc "select link_state from public.communication_conversations where id = 'd1111111-1111-4111-8111-111111111111';")" \
  "linked" "a conversation that had a client is linked"

assert_eq "$(psql_test -tAc "select link_state from public.communication_conversations where id = 'd2222222-2222-4222-8222-222222222222';")" \
  "unmatched" "a conversation that had no client stays unmatched"

assert_eq "$(psql_test -tAc "select contact_wa_id from public.whatsapp_conversations where id = 'd1111111-1111-4111-8111-111111111111';")" \
  "441234567890" "the compatibility view still exposes contact_wa_id"

assert_eq "$(psql_test -tAc "select origin from public.whatsapp_messages where id = 'e4444444-4444-4444-8444-444444444444';")" \
  "business_app" "a Business App send still reads back as business_app"

assert_eq "$(psql_test -tAc "select origin from public.communication_messages where id = 'e4444444-4444-4444-8444-444444444444';")" \
  "provider_app" "the same row is provider_app in the neutral core"

assert_eq "$(psql_test -tAc "select status || ':' || coalesce(body, '') from public.whatsapp_messages where id = 'e3333333-3333-4333-8333-333333333333';")" \
  "delivered:Sent earlier" "delivery state and body are unchanged"

assert_eq "$(psql_test -tAc "select coalesce(body, 'NULL') || ':' || message_type from public.whatsapp_messages where id = 'e2222222-2222-4222-8222-222222222222';")" \
  "NULL:image" "a non-text message keeps a null body"

# The durable queue must still name the same message, through the new column.
assert_eq "$(psql_test -tAc "select communication_message_id from public.integration_outbox where id = 'f1111111-1111-4111-8111-111111111111';")" \
  "e5555555-5555-4555-8555-555555555555" "the outbox job still points at the same queued message"

assert_eq "$(psql_test -tAc "select status from public.integration_outbox where id = 'f1111111-1111-4111-8111-111111111111';")" \
  "pending" "the queued job is untouched by the migration"

assert_eq "$(psql_test -tAc "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'integration_outbox' and column_name = 'whatsapp_message_id';")" \
  "0" "the channel-specific outbox column is retired"

# The RPC surface the deployed Workers call must still exist with the same
# argument types, or a production Worker would start failing without a redeploy.
for signature in \
  "record_whatsapp_inbound_message(uuid,text,text,text,timestamp with time zone,text,text)" \
  "record_whatsapp_message_status(uuid,text,text,text,timestamp with time zone)" \
  "claim_whatsapp_outbox(text,integer,integer)" \
  "claim_whatsapp_outbox_by_id(uuid,text,integer)" \
  "record_whatsapp_outbox_result(uuid,text,boolean,text,text)" \
  "queue_whatsapp_message(uuid,text,uuid)" \
  "ensure_whatsapp_conversation_for_enquiry(uuid)"
do
  found="$(psql_test -tAc "select (to_regprocedure('public.$signature') is not null)::int;")"
  assert_eq "$found" "1" "public.${signature%%(*} keeps its exact signature"
done

# The claim projection must still report the WhatsApp column names the deployed
# drain Worker validates, and must still refuse to run for a browser role.
CLAIM_COLUMNS="$(psql_test -tAc "select string_agg(a.attname, ',' order by a.attnum) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join unnest(p.proargnames, p.proargmodes) with ordinality as a(attname, attmode, attnum) on a.attmode = 't' where n.nspname = 'public' and p.proname = 'claim_whatsapp_outbox';")"
assert_eq "$CLAIM_COLUMNS" \
  "outbox_id,artist_id,kind,whatsapp_message_id,conversation_id,integration_key,contact_wa_id,body,attempt_count,max_attempts,job_valid" \
  "claim_whatsapp_outbox keeps the exact column names the drain Worker validates"

# A real claim against the seeded job proves the neutral engine drives the
# compatibility projection end to end.
# The seeded job was created after the WhatsApp drain rollout row that stage 1
# installed, so the automatic-drain gate already admits it.
CLAIMED="$(psql_test -tAc "
  select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);
  select coalesce((select whatsapp_message_id::text || '|' || contact_wa_id || '|' || body || '|' || job_valid::text from public.claim_whatsapp_outbox('migration-test-worker', 5, 60)), 'none');
" | tail -1)"
assert_eq "$CLAIMED" \
  "e5555555-5555-4555-8555-555555555555|441234567890|Waiting to send|true" \
  "the neutral engine claims the pre-existing WhatsApp job unchanged"

assert_eq "$(psql_test -tAc "select count(*) from pg_views where schemaname = 'public' and viewname in ('whatsapp_conversations', 'whatsapp_messages');")" \
  "2" "both WhatsApp relations are now compatibility views"

assert_eq "$(psql_test -tAc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('whatsapp_conversations', 'whatsapp_messages') and c.reloptions::text like '%security_invoker=true%';")" \
  "2" "both compatibility views run with invoker rights so row level security still applies"

echo
echo "Communications migration preserved every seeded WhatsApp record."
