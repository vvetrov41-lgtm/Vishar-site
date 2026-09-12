import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AUTOMATION_BACKEND_RPCS, LIFECYCLE_ALERT_RPCS, TELEGRAM_SELF_SERVICE_RPCS } from '../workers/lib/supabase.js';
import { __testing as telegramDrainTesting } from '../workers/lib/telegram-drain.js';
import { buildPersonalNotification } from '../workers/lib/telegram.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const directivesOf = (text) => text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean).join('\n');
const expectIncludes = (text, needle, label) => { if (!text.includes(needle)) throw new Error(`${label}: missing ${needle}`); };
const expectExcludes = (text, needle, label) => { if (text.includes(needle)) throw new Error(`${label}: forbidden ${needle}`); };

const telegramRpcSurface = [...TELEGRAM_SELF_SERVICE_RPCS].sort();
const expectedTelegramRpcSurface = ['service_claim_telegram_notifications','service_complete_telegram_link','service_record_telegram_notification_result','service_resolve_telegram_destination','service_route_telegram_enquiry_notification'].sort();
if (JSON.stringify(telegramRpcSurface) !== JSON.stringify(expectedTelegramRpcSurface)) throw new Error('Telegram self-service Worker RPC surface changed');
if (JSON.stringify([...LIFECYCLE_ALERT_RPCS]) !== JSON.stringify(['service_sweep_lifecycle_failure_alerts'])) throw new Error('Lifecycle alert backend Worker RPC surface changed');
if (JSON.stringify([...AUTOMATION_BACKEND_RPCS].sort()) !== JSON.stringify(['service_run_automation_tick'])) throw new Error('Automation backend Worker RPC surface changed');

const sessionId = '55555555-5555-4555-8555-555555555555';
const productionTarget = telegramDrainTesting.personalNotificationActionUrl({ VISHAR_ENVIRONMENT: 'production', CRM_ORIGIN: 'https://crm.vishartattoo.com' }, 'session', sessionId);
if (productionTarget !== `https://crm.vishartattoo.com/#/appointments/${sessionId}`) throw new Error('production session target is incorrect');
const renderedPersonal = buildPersonalNotification({ title: 'Client requested reschedule', body: 'Open the appointment to review the request.', actionUrl: productionTarget });
expectIncludes(renderedPersonal, `Open in CRM: https://crm.vishartattoo.com/#/appointments/${sessionId}`, 'personal notification renderer');

const tracked = directivesOf(read('wrangler.telegram-drain.production.toml'));
for (const needle of [
  'name = "vishar-telegram-drain-production"', 'main = "workers/telegram-drain-worker.js"',
  'workers_dev = false', 'preview_urls = false', 'VISHAR_ENVIRONMENT = "production"',
  'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"', 'CRM_ORIGIN = "https://crm.vishartattoo.com"',
  'TELEGRAM_DRAIN_ENABLED = "false"', 'GMAIL_SHARED_DRAIN_ENABLED = "false"', 'AUTOMATION_TICK_ENABLED = "false"',
  'ENQUIRY_AI_SHARED_DRAIN_ENABLED = "false"', 'CRM_AGENT_SHARED_DRAIN_ENABLED = "false"',
  'CRM_AGENT_TELEGRAM_DIGEST_ENABLED = "false"', 'TELEGRAM_LINKING_ENABLED = "false"',
]) expectIncludes(tracked, needle, 'tracked config');
for (const needle of ['[triggers]','crons =','[[services]]','gwaliusblwrzisrwnsvs','vishar-telegram-drain-staging','TELEGRAM_CHAT_ID','GOOGLE_OAUTH_CLIENT_SECRET','GMAIL_TOKEN_ENCRYPTION_KEY']) expectExcludes(tracked, needle, 'tracked config');

const rootTattooConfig = directivesOf(read('wrangler.toml'));
expectExcludes(rootTattooConfig, '[triggers]', 'TattooAI config');
expectExcludes(rootTattooConfig, 'crons =', 'TattooAI config');
expectIncludes(rootTattooConfig, 'CRM_AI_IMAGES_ENABLED = "false"', 'TattooAI config');
expectIncludes(rootTattooConfig, 'CRM_AGENT_ENABLED = "true"', 'TattooAI config');
expectIncludes(rootTattooConfig, 'CRM_AGENT_VISION_ENABLED = "true"', 'TattooAI config');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-production-'));
const generatedPath = path.join(tempDir, 'wrangler.telegram.production.deploy.toml');
try {
  const generator = path.join(root, 'scripts/generate-telegram-production-deploy-config.mjs');
  const result = spawnSync(process.execPath, [generator, generatedPath], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'generator failed');
  const generated = directivesOf(fs.readFileSync(generatedPath, 'utf8'));
  const main = generated.match(/^main = "([^"]+)"$/m)?.[1];
  if (!main) throw new Error('generated config: main missing');
  const resolved = path.resolve(path.dirname(generatedPath), main);
  if (resolved !== path.join(root, 'workers/telegram-production-scheduler.js')) throw new Error(`generated main mismatch: ${resolved}`);
  for (const needle of [
    'TELEGRAM_DRAIN_ENABLED = "true"','GMAIL_SHARED_DRAIN_ENABLED = "true"','AUTOMATION_TICK_ENABLED = "true"',
    'ENQUIRY_AI_SHARED_DRAIN_ENABLED = "true"','CRM_AGENT_SHARED_DRAIN_ENABLED = "true"',
    'CRM_AGENT_TELEGRAM_DIGEST_ENABLED = "true"','TELEGRAM_LINKING_ENABLED = "false"',
    'binding = "GMAIL_SERVICE"','service = "vishar-gmail-production"',
    'binding = "TATTOOAI_SERVICE"','service = "tattooai"',
    '[triggers]','crons = ["*/5 * * * *"]','[secrets]','"SUPABASE_SECRET_KEY"',
  ]) expectIncludes(generated, needle, 'generated config');
  for (const needle of [
    'entrypoint =','TELEGRAM_DRAIN_ENABLED = "false"','GMAIL_SHARED_DRAIN_ENABLED = "false"',
    'AUTOMATION_TICK_ENABLED = "false"','ENQUIRY_AI_SHARED_DRAIN_ENABLED = "false"',
    'CRM_AGENT_SHARED_DRAIN_ENABLED = "false"','CRM_AGENT_TELEGRAM_DIGEST_ENABLED = "false"','gwaliusblwrzisrwnsvs',
  ]) expectExcludes(generated, needle, 'generated config');

  const badFlag = spawnSync(process.execPath, [generator, generatedPath, '--unknown'], { encoding: 'utf8' });
  if (badFlag.status === 0) throw new Error('generator accepted an unknown production option');
} finally { fs.rmSync(tempDir, { recursive: true, force: true }); }

const sharedScheduler = spawnSync(process.execPath, [path.join(root, 'scripts/test-enquiry-ai-shared-scheduler.mjs')], { encoding: 'utf8' });
if (sharedScheduler.status !== 0) throw new Error(sharedScheduler.stderr || sharedScheduler.stdout || 'shared enquiry AI scheduler test failed');

const workflow = read('.github/workflows/deploy-private-production-telegram.yml');
for (const needle of ['environment: crm-production','release/private-crm-rc*','approved_sha','node scripts/generate-telegram-production-deploy-config.mjs','GMAIL_SHARED_DRAIN_ENABLED = "true"','binding = "GMAIL_SERVICE"','crons = ["*/5 * * * *"]','--dry-run','WRANGLER_OUTPUT_FILE_PATH="$deploy_output"','wrangler versions list']) expectIncludes(workflow, needle, 'production workflow');
for (const needle of ['wrangler secret put','wrangler secret bulk','wrangler pages deploy','supabase db push','wrangler.telegram-drain.staging.toml','gwaliusblwrzisrwnsvs','TELEGRAM_CHAT_ID']) expectExcludes(workflow, needle, 'production workflow');

console.log('Telegram production configuration boundaries passed: one shared 5-minute scheduler owns Telegram, Gmail, lifecycle, enquiry AI and CRM Five Pillars dispatch; TattooAI has no standalone cron.');