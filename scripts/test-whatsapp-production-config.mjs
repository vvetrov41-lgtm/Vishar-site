// Proves the tracked WhatsApp production configuration is inert, that the
// generated deploy config is the only thing that activates it, and that the
// guarded workflow keeps its production boundaries.
//
// Nothing here deploys, and nothing here reads a credential.

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

// ---------------------------------------------------------------------------
// The tracked template must stay inert
// ---------------------------------------------------------------------------

const tracked = directivesOf(read('wrangler.whatsapp-drain.production.toml'));
expectIncludes(tracked, 'name = "vishar-whatsapp-drain-production"', 'tracked config');
expectIncludes(tracked, 'main = "workers/whatsapp-drain-worker.js"', 'tracked config');
expectIncludes(tracked, 'workers_dev = false', 'tracked config');
expectIncludes(tracked, 'preview_urls = false', 'tracked config');
expectIncludes(tracked, 'VISHAR_ENVIRONMENT = "production"', 'tracked config');
expectIncludes(tracked, 'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"', 'tracked config');
expectIncludes(tracked, 'WHATSAPP_DRAIN_ENABLED = "false"', 'tracked config');
expectExcludes(tracked, '[triggers]', 'tracked config');
expectExcludes(tracked, 'crons =', 'tracked config');
expectExcludes(tracked, 'gwaliusblwrzisrwnsvs', 'tracked config');
expectExcludes(tracked, 'vishar-whatsapp-drain-staging', 'tracked config');
expectExcludes(tracked, 'workers_dev = true', 'tracked config');
expectExcludes(tracked, 'preview_urls = true', 'tracked config');
// No global provider binding may ever be declared on this Worker.
expectExcludes(tracked, 'WHATSAPP_ACCESS_TOKEN', 'tracked config');
expectExcludes(tracked, 'WHATSAPP_PHONE_NUMBER_ID', 'tracked config');
expectExcludes(tracked, 'WHATSAPP_APP_SECRET', 'tracked config');

// ---------------------------------------------------------------------------
// The generated deploy config is the only activation path
// ---------------------------------------------------------------------------

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-production-'));
const generatedPath = path.join(tempDir, 'wrangler.whatsapp.production.deploy.toml');
try {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-whatsapp-production-deploy-config.mjs'),
    generatedPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'generator failed');

  const generated = directivesOf(fs.readFileSync(generatedPath, 'utf8'));
  expectIncludes(generated, 'WHATSAPP_DRAIN_ENABLED = "true"', 'generated config');
  expectIncludes(generated, '[triggers]', 'generated config');
  expectIncludes(generated, 'crons = ["*/5 * * * *"]', 'generated config');
  expectIncludes(generated, '[secrets]', 'generated config');
  expectIncludes(generated, '"SUPABASE_SECRET_KEY"', 'generated config');
  expectIncludes(generated, '"ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION"', 'generated config');
  expectIncludes(generated, '"ARTIST_WHATSAPP_KRISTINA_HPRODUCTION"', 'generated config');
  expectExcludes(generated, 'WHATSAPP_DRAIN_ENABLED = "false"', 'generated config');

  // Generating must never mutate the tracked template.
  const trackedAfter = directivesOf(read('wrangler.whatsapp-drain.production.toml'));
  if (trackedAfter !== tracked) throw new Error('generator mutated the tracked production template');

  // Refusing to overwrite the source is part of the contract.
  const overwrite = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-whatsapp-production-deploy-config.mjs'),
    path.join(root, 'wrangler.whatsapp-drain.production.toml'),
  ], { encoding: 'utf8' });
  if (overwrite.status === 0) throw new Error('generator overwrote the tracked production template');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The guarded workflow keeps its boundaries
// ---------------------------------------------------------------------------

const workflow = read('.github/workflows/deploy-private-production-whatsapp.yml');
for (const needle of [
  'environment: crm-production',
  'release/private-crm-rc*',
  'approved_sha',
  'cancel-in-progress: false',
  'ENABLE_PRIVATE_CRM_WHATSAPP_DRAIN',
  'CRM_PRODUCTION_WHATSAPP_DEPLOY_ENABLED',
  'wrangler secret list',
  'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION',
  'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION',
  '--strict',
  'wrangler versions list',
  'wrangler deployments list',
  'safe-summary.json',
]) expectIncludes(workflow, needle, 'production workflow');

for (const needle of [
  // Secret values are never written or read by this workflow.
  'wrangler secret put',
  'wrangler secret bulk',
  // No other surface may be deployed from the WhatsApp gate.
  'wrangler pages deploy',
  'supabase db push',
  'wrangler.whatsapp-drain.staging.toml',
  'gwaliusblwrzisrwnsvs',
  // A scheduled-only connector declares no route or Custom Domain.
  '--route',
  '--domain',
  // Meta-side actions must never be automated from CI.
  'graph.facebook.com',
  'embedded_signup',
  'phone_number/register',
]) expectExcludes(workflow, needle, 'production workflow');

// The Worker itself must remain gated on the exact enable string.
const workerSource = read('workers/whatsapp-drain-worker.js');
expectIncludes(workerSource, "env.WHATSAPP_DRAIN_ENABLED !== 'true'", 'drain Worker');
expectExcludes(workerSource, 'async fetch(', 'drain Worker');

console.log(
  'WhatsApp production config tests passed: tracked template inert, generated config activates '
  + 'exactly one drain with one cron, and the guarded workflow writes no secret and touches no Meta account.'
);
