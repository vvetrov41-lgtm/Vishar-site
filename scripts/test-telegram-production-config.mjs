import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

const tracked = directivesOf(read('wrangler.telegram-drain.production.toml'));
expectIncludes(tracked, 'name = "vishar-telegram-drain-production"', 'tracked config');
expectIncludes(tracked, 'main = "workers/telegram-drain-worker.js"', 'tracked config');
expectIncludes(tracked, 'workers_dev = false', 'tracked config');
expectIncludes(tracked, 'preview_urls = false', 'tracked config');
expectIncludes(tracked, 'VISHAR_ENVIRONMENT = "production"', 'tracked config');
expectIncludes(tracked, 'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"', 'tracked config');
expectIncludes(tracked, 'TELEGRAM_DRAIN_ENABLED = "false"', 'tracked config');
expectExcludes(tracked, '[triggers]', 'tracked config');
expectExcludes(tracked, 'crons =', 'tracked config');
expectExcludes(tracked, 'gwaliusblwrzisrwnsvs', 'tracked config');
expectExcludes(tracked, 'vishar-telegram-drain-staging', 'tracked config');
expectExcludes(tracked, 'workers_dev = true', 'tracked config');
expectExcludes(tracked, 'preview_urls = true', 'tracked config');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-production-'));
const generatedPath = path.join(tempDir, 'wrangler.telegram.production.deploy.toml');
try {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-telegram-production-deploy-config.mjs'),
    generatedPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'generator failed');
  const generated = directivesOf(fs.readFileSync(generatedPath, 'utf8'));
  expectIncludes(generated, 'TELEGRAM_DRAIN_ENABLED = "true"', 'generated config');
  expectIncludes(generated, '[triggers]', 'generated config');
  expectIncludes(generated, 'crons = ["*/5 * * * *"]', 'generated config');
  expectIncludes(generated, '[secrets]', 'generated config');
  expectIncludes(generated, '"SUPABASE_SECRET_KEY"', 'generated config');
  expectIncludes(generated, '"ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION"', 'generated config');
  expectIncludes(generated, '"ARTIST_TELEGRAM_KRISTINA_HPRODUCTION"', 'generated config');
  expectExcludes(generated, 'TELEGRAM_DRAIN_ENABLED = "false"', 'generated config');
  expectExcludes(generated, 'gwaliusblwrzisrwnsvs', 'generated config');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const workflow = read('.github/workflows/deploy-private-production-telegram.yml');
for (const needle of [
  'environment: crm-production',
  'release/private-crm-rc*',
  'approved_sha',
  "'ENABLE_PRIVATE_CRM_TELEGRAM_DRAIN'",
  'wrangler.telegram-drain.production.toml',
  'node scripts/generate-telegram-production-deploy-config.mjs',
  'npm run check:telegram-production-bundle',
  'npm run scan:secrets',
  'wrangler secret list',
  '--dry-run',
  '--strict',
  'wrangler deployments list',
  'wrangler versions list',
]) expectIncludes(workflow, needle, 'production workflow');
for (const needle of [
  'wrangler secret put',
  'wrangler secret bulk',
  'wrangler pages deploy',
  'supabase db push',
  'wrangler.telegram-drain.staging.toml',
  'gwaliusblwrzisrwnsvs',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  '--route',
  '--domain',
]) expectExcludes(workflow, needle, 'production workflow');

console.log('Telegram production configuration boundaries: passed');
