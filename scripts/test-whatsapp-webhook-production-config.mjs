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
  'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION',
  'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION',
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
  'workflow_dispatch:',
  'environment: crm-production',
  'release/private-crm-rc*',
  'approved_sha',
  'CRM_PRODUCTION_WHATSAPP_WEBHOOK_DEPLOY_ENABLED',
  'EXPOSE_PRIVATE_CRM_WHATSAPP_WEBHOOK',
  'vishar-whatsapp-webhook-production',
  'whatsapp.vishartattoo.com',
  'wrangler secret list',
  'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'SUPABASE_SECRET_KEY',
  '--dry-run',
  '--strict',
  'WRANGLER_OUTPUT_FILE_PATH',
  'wrangler_deploy_event',
  'Pre-provisioned Custom Domain',
  'Kristina production binding is intentionally absent',
]) {
  assert.ok(workflow.includes(required), `production webhook workflow must contain ${JSON.stringify(required)}`);
}

for (const forbidden of [
  'push:',
  'pull_request:',
  'wrangler secret put',
  'wrangler secret bulk',
  'supabase db push',
  'wrangler pages deploy',
  'wrangler.telegram',
  'wrangler.calendar',
  'wrangler.team-admin',
  'gwaliusblwrzisrwnsvs',
  'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION',
]) {
  assert.ok(!workflow.includes(forbidden), `production webhook workflow must not contain ${JSON.stringify(forbidden)}`);
}

console.log('WhatsApp webhook production config tests passed: exact pre-provisioned Custom Domain, Vladimir-only signed closed callback surface and guarded workflow-only deployment.');
