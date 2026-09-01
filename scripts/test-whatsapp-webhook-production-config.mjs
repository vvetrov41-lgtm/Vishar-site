#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = fs.readFileSync('wrangler.whatsapp-webhook.production.toml', 'utf8');
const worker = fs.readFileSync('workers/whatsapp-webhook-worker.js', 'utf8');
const webhook = fs.readFileSync('workers/lib/whatsapp-webhook.js', 'utf8');
const workflow = fs.readFileSync('.github/workflows/deploy-private-production-whatsapp-webhook.yml', 'utf8');

assert.match(config, /^name = "vishar-whatsapp-webhook-production"$/m);
assert.match(config, /^main = "workers\/whatsapp-webhook-worker\.js"$/m);
assert.match(config, /^workers_dev = false$/m);
assert.match(config, /^preview_urls = false$/m);
assert.match(config, /^VISHAR_ENVIRONMENT = "production"$/m);
assert.match(config, /^SUPABASE_URL = "https:\/\/vfjexhfdbrjmuxfdvbdx\.supabase\.co"$/m);
assert.match(config, /^WHATSAPP_VLADIMIR_ARTIST_ID = "a1111111-1111-4111-8111-111111111111"$/m);
assert.match(config, /^WHATSAPP_KRISTINA_ARTIST_ID = "a2222222-2222-4222-8222-222222222222"$/m);
assert.match(config, /pattern = "whatsapp\.vishartattoo\.com"/);
assert.match(config, /zone_name = "vishartattoo\.com"/);
assert.match(config, /custom_domain = true/);
assert.match(config, /enabled = true/);
assert.match(config, /previews_enabled = false/);

for (const forbidden of [
  '[triggers]',
  'pattern = "*',
  'workers.dev = true',
  'preview_urls = true',
  'previews_enabled = true',
  'calendar-staging',
  'gwaliusblwrzisrwnsvs',
  'WHATSAPP_ACCESS_TOKEN =',
  'WHATSAPP_PHONE_NUMBER_ID =',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN =',
  'SUPABASE_SECRET_KEY =',
]) {
  assert.ok(!config.includes(forbidden), `tracked webhook config must not contain ${JSON.stringify(forbidden)}`);
}

for (const required of [
  'SUPABASE_SECRET_KEY',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'ARTIST_WHATSAPP_<ROUTE_ENCODED>_HPRODUCTION',
]) {
  assert.ok(config.includes(required), `tracked comments must document required secret name ${required}`);
}

assert.ok(webhook.includes("'/webhook'"), 'webhook path must be closed to one exact path');
assert.ok(webhook.includes('X-Hub-Signature-256'), 'raw Meta signature header must be checked');
assert.ok(webhook.includes("field !== 'messages'"), 'only the official messages webhook field is interpreted');
assert.ok(webhook.includes('smb_message_echoes'), 'undocumented coexistence echo handling must be explicitly documented as disabled');
assert.ok(!webhook.includes('Access-Control-Allow-Origin'), 'public Meta callback must not expose a browser CORS API');
assert.ok(!worker.includes('console.log'), 'entrypoint must not log webhook payloads');

for (const required of [
  'push:',
  'workflow_dispatch:',
  'environment: crm-production',
  "'release/private-crm-rc*-whatsapp-webhook-only'",
  '^release/private-crm-rc[0-9]+-whatsapp-webhook-only$',
  'approved_sha',
  'github.event_name == \'push\' && github.sha || inputs.approved_sha',
  'github.event_name == \'push\' || inputs.deploy',
  '[ "$GITHUB_ACTOR" = "$GITHUB_REPOSITORY_OWNER" ]',
  'refs/heads/$PRODUCT_BRANCH',
  'refs/heads/$GITHUB_REF_NAME',
  'actions/runs?head_sha=$GITHUB_SHA',
  'Canonical CRM branch moved after validation; refusing webhook deployment.',
  'Webhook-only release ref moved after validation; refusing deployment.',
  'Static Validation',
  'CRM and booking validation',
  'Gmail production validation',
  'Booking host validation',
  'WhatsApp production onboarding validation',
  'CRM_PRODUCTION_WHATSAPP_WEBHOOK_DEPLOY_ENABLED',
  'EXPOSE_PRIVATE_CRM_WHATSAPP_WEBHOOK',
  'vishar-whatsapp-webhook-production',
  'whatsapp.vishartattoo.com',
  'wrangler secret list',
  'validate-whatsapp-production-secret-names.mjs webhook',
  'test-whatsapp-production-secret-names.mjs',
  '--dry-run',
  '--strict',
  'WRANGLER_OUTPUT_FILE_PATH',
  'wrangler_deploy_event',
  'Pre-provisioned Custom Domain',
]) {
  assert.ok(workflow.includes(required), `production webhook workflow must contain ${JSON.stringify(required)}`);
}

for (const forbidden of [
  'pull_request:',
  'pull_request_target:',
  'repository_dispatch:',
  'workflow_run:',
  'wrangler secret put',
  'wrangler secret bulk',
  'supabase db push',
  'wrangler pages deploy',
  'wrangler.telegram',
  'wrangler.calendar',
  'wrangler.team-admin',
  'gwaliusblwrzisrwnsvs',
]) {
  assert.ok(!workflow.includes(forbidden), `production webhook workflow must not contain ${JSON.stringify(forbidden)}`);
}

assert.ok(
  workflow.split('refs/heads/$PRODUCT_BRANCH').length - 1 >= 2,
  'production webhook workflow must re-read canonical immediately before deployment',
);
assert.ok(
  workflow.split('refs/heads/$GITHUB_REF_NAME').length - 1 >= 2,
  'production webhook workflow must re-read the webhook-only release ref immediately before deployment',
);

console.log('WhatsApp webhook production config tests passed: exact pre-provisioned Custom Domain, signed closed callback surface and guarded exact-head deployment.');
