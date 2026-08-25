import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AUTOMATION_BACKEND_RPCS,
  TELEGRAM_SELF_SERVICE_RPCS,
} from '../workers/lib/supabase.js';
import { __testing as telegramDrainTesting } from '../workers/lib/telegram-drain.js';
import { buildPersonalNotification } from '../workers/lib/telegram.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const directivesOf = (text) => text
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');
const expectIncludes = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const expectExcludes = (text, needle, label) => {
  if (text.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};
const expectGeneratedMainResolvesToWorker = (text, configPath, label) => {
  const main = text.match(/^main = "([^"]+)"$/m)?.[1];
  if (!main) throw new Error(`${label}: generated main entrypoint is missing`);
  if (path.isAbsolute(main)) throw new Error(`${label}: generated main must remain relative to the config`);
  const resolved = path.resolve(path.dirname(configPath), main);
  const expected = path.join(root, 'workers/telegram-drain-worker.js');
  if (resolved !== expected) {
    throw new Error(`${label}: generated main resolves to ${resolved}, expected ${expected}`);
  }
};

const telegramRpcSurface = [...TELEGRAM_SELF_SERVICE_RPCS].sort();
const expectedTelegramRpcSurface = [
  'service_claim_telegram_notifications',
  'service_claim_telegram_notifications_v2',
  'service_complete_telegram_link',
  'service_record_telegram_notification_result',
  'service_resolve_telegram_destination',
].sort();
if (JSON.stringify(telegramRpcSurface) !== JSON.stringify(expectedTelegramRpcSurface)) {
  throw new Error(`Telegram self-service Worker RPC surface changed: ${telegramRpcSurface.join(', ')}`);
}

const automationRpcSurface = [...AUTOMATION_BACKEND_RPCS].sort();
if (JSON.stringify(automationRpcSurface) !== JSON.stringify(['service_run_automation_tick'])) {
  throw new Error(`Automation backend Worker RPC surface changed: ${automationRpcSurface.join(', ')}`);
}

const sessionId = '55555555-5555-4555-8555-555555555555';
const productionTarget = telegramDrainTesting.personalNotificationActionUrl({
  VISHAR_ENVIRONMENT: 'production',
  CRM_ORIGIN: 'https://crm.vishartattoo.com',
}, 'session', sessionId);
if (productionTarget !== `https://crm.vishartattoo.com/#/appointments/${sessionId}`) {
  throw new Error(`production session target is incorrect: ${productionTarget}`);
}
if (telegramDrainTesting.personalNotificationActionUrl({
  VISHAR_ENVIRONMENT: 'production',
  CRM_ORIGIN: 'https://evil.example.test',
}, 'session', sessionId) !== null) {
  throw new Error('production session target accepted a non-Vishar CRM origin');
}
const renderedPersonal = buildPersonalNotification({
  title: 'Client requested reschedule',
  body: 'Open the appointment to review the request.',
  actionUrl: productionTarget,
});
expectIncludes(renderedPersonal, `Open in CRM: https://crm.vishartattoo.com/#/appointments/${sessionId}`,
  'personal notification renderer');

const tracked = directivesOf(read('wrangler.telegram-drain.production.toml'));
for (const needle of [
  'name = "vishar-telegram-drain-production"',
  'main = "workers/telegram-drain-worker.js"',
  'workers_dev = false',
  'preview_urls = false',
  '{ pattern = "telegram.vishartattoo.com", zone_name = "vishartattoo.com", custom_domain = true, enabled = true, previews_enabled = false }',
  'VISHAR_ENVIRONMENT = "production"',
  'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"',
  'CRM_ORIGIN = "https://crm.vishartattoo.com"',
  'TELEGRAM_DRAIN_ENABLED = "false"',
  'GMAIL_SHARED_DRAIN_ENABLED = "false"',
  'AUTOMATION_TICK_ENABLED = "false"',
  'TELEGRAM_LINKING_ENABLED = "false"',
]) expectIncludes(tracked, needle, 'tracked config');
for (const needle of [
  '[triggers]',
  'crons =',
  '[[services]]',
  'gwaliusblwrzisrwnsvs',
  'vishar-telegram-drain-staging',
  'workers_dev = true',
  'preview_urls = true',
  'TELEGRAM_CHAT_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GMAIL_TOKEN_ENCRYPTION_KEY',
  'GMAIL_OAUTH_STATE',
  'GMAIL_OAUTH_TOKENS',
]) expectExcludes(tracked, needle, 'tracked config');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-production-'));
const generatedPath = path.join(tempDir, 'wrangler.telegram.production.deploy.toml');
const linkingPath = path.join(tempDir, 'wrangler.telegram.production.linking.toml');
try {
  const generator = path.join(root, 'scripts/generate-telegram-production-deploy-config.mjs');
  const result = spawnSync(process.execPath, [generator, generatedPath], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'generator failed');
  const generated = directivesOf(fs.readFileSync(generatedPath, 'utf8'));
  expectGeneratedMainResolvesToWorker(generated, generatedPath, 'generated config');
  for (const needle of [
    'CRM_ORIGIN = "https://crm.vishartattoo.com"',
    'TELEGRAM_DRAIN_ENABLED = "true"',
    'GMAIL_SHARED_DRAIN_ENABLED = "true"',
    'AUTOMATION_TICK_ENABLED = "true"',
    'TELEGRAM_LINKING_ENABLED = "false"',
    'telegram.vishartattoo.com',
    '[[services]]',
    'binding = "GMAIL_SERVICE"',
    'service = "vishar-gmail-production"',
    '[triggers]',
    'crons = ["*/5 * * * *"]',
    '[secrets]',
    '"SUPABASE_SECRET_KEY"',
    '"ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION"',
    '"ARTIST_TELEGRAM_KRISTINA_HPRODUCTION"',
    '"TELEGRAM_BOT_TOKEN"',
    '"TELEGRAM_WEBHOOK_SECRET"',
  ]) expectIncludes(generated, needle, 'generated config');
  for (const needle of [
    'TELEGRAM_DRAIN_ENABLED = "false"',
    'GMAIL_SHARED_DRAIN_ENABLED = "false"',
    'AUTOMATION_TICK_ENABLED = "false"',
    'TELEGRAM_LINKING_ENABLED = "true"',
    'TELEGRAM_CHAT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GMAIL_TOKEN_ENCRYPTION_KEY',
    'gwaliusblwrzisrwnsvs',
  ]) expectExcludes(generated, needle, 'generated config');

  const linkingResult = spawnSync(process.execPath, [
    generator,
    linkingPath,
    '--enable-linking',
  ], { encoding: 'utf8' });
  if (linkingResult.status !== 0) {
    throw new Error(linkingResult.stderr || linkingResult.stdout || 'linking generator failed');
  }
  const linking = directivesOf(fs.readFileSync(linkingPath, 'utf8'));
  expectGeneratedMainResolvesToWorker(linking, linkingPath, 'linking config');
  expectIncludes(linking, 'CRM_ORIGIN = "https://crm.vishartattoo.com"', 'linking config');
  expectIncludes(linking, 'TELEGRAM_LINKING_ENABLED = "true"', 'linking config');
  expectIncludes(linking, 'GMAIL_SHARED_DRAIN_ENABLED = "true"', 'linking config');
  expectIncludes(linking, 'AUTOMATION_TICK_ENABLED = "true"', 'linking config');
  expectIncludes(linking, 'binding = "GMAIL_SERVICE"', 'linking config');
  expectIncludes(linking, 'crons = ["*/5 * * * *"]', 'linking config');

  const badFlag = spawnSync(process.execPath, [generator, linkingPath, '--unknown'], { encoding: 'utf8' });
  if (badFlag.status === 0) throw new Error('generator accepted an unknown production option');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const cutover = spawnSync(process.execPath, [
  path.join(root, 'scripts/test-telegram-registry-cutover.mjs'),
], { encoding: 'utf8' });
if (cutover.status !== 0) {
  throw new Error(cutover.stderr || cutover.stdout || 'Telegram registry cutover test failed');
}

const workflow = read('.github/workflows/deploy-private-production-telegram.yml');
for (const needle of [
  'environment: crm-production',
  'release/private-crm-rc*',
  'approved_sha',
  'enable_linking:',
  'linking_approval_phrase:',
  'disable_linking:',
  'linking_rollback_phrase:',
  "'ENABLE_PRIVATE_CRM_TELEGRAM_DRAIN'",
  "'ENABLE_TELEGRAM_LINKING'",
  "'DISABLE_TELEGRAM_LINKING'",
  'enable_linking and disable_linking are mutually exclusive',
  'enable_linking=true is valid only with deploy=true',
  'disable_linking=true is valid only with deploy=true',
  'wrangler.telegram-drain.production.toml',
  'node scripts/generate-telegram-production-deploy-config.mjs',
  'generator_args+=(--enable-linking)',
  'preflight_args+=(--allow-linking)',
  'preflight_args+=(--allow-linking-disable)',
  'GMAIL_SHARED_DRAIN_ENABLED = "true"',
  'binding = "GMAIL_SERVICE"',
  'service = "vishar-gmail-production"',
  'node scripts/test-telegram-self-service-worker.mjs',
  'npm run test:telegram-production',
  'npm run check:telegram-production-bundle',
  'npm run scan:secrets',
  'wrangler secret list',
  "'TELEGRAM_BOT_TOKEN'",
  "'TELEGRAM_WEBHOOK_SECRET'",
  '--dry-run',
  'WRANGLER_OUTPUT_FILE_PATH="$deploy_output"',
  "entry?.type === 'deploy'",
  "version_source: 'wrangler_deploy_event'",
  'versions.some((entry) => entry?.id === deployedVersionId)',
  'wrangler deployments list',
  'wrangler versions list',
]) expectIncludes(workflow, needle, 'production workflow');
for (const needle of [
  'versions[0].id',
  'wrangler secret put',
  'wrangler secret bulk',
  'wrangler pages deploy',
  'supabase db push',
  'wrangler.telegram-drain.staging.toml',
  'gwaliusblwrzisrwnsvs',
  'TELEGRAM_CHAT_ID',
  'scripts/activate-telegram-webhook.mjs',
  'api.telegram.org',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GMAIL_TOKEN_ENCRYPTION_KEY',
]) expectExcludes(workflow, needle, 'production workflow');

if (/^\s*--strict\s*$/m.test(workflow)) {
  throw new Error('production workflow: forbidden executable Wrangler strict-mode flag');
}

const preflightCall = 'node scripts/preflight-telegram-production.mjs "${preflight_args[@]}"';
const preflightCallCount = workflow.split(preflightCall).length - 1;
if (preflightCallCount !== 2) {
  throw new Error(`production workflow: expected preflight immediately before and after deploy, found ${preflightCallCount}`);
}

console.log('Telegram production configuration boundaries: fail-closed preflight preserves Gmail, pins the CRM origin for exact appointment links, enables one bounded automation heartbeat on the existing cron, gates linking, and keeps Artist delivery registry-only.');
