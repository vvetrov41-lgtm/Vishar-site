#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = await readFile(new URL('../wrangler.booking-host.production.toml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../workers/booking-host.js', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(new URL('../.github/workflows/deploy-production-booking-host.yml', import.meta.url), 'utf8');
const activeConfig = config
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

assert.match(activeConfig, /^name = "vishar-booking-host-production"$/m);
assert.match(activeConfig, /^main = "workers\/booking-host\.js"$/m);
assert.match(activeConfig, /^workers_dev = false$/m);
assert.match(activeConfig, /^preview_urls = false$/m);
assert.doesNotMatch(activeConfig, /^routes\s*=/m);
assert.doesNotMatch(activeConfig, /pattern\s*=/);
assert.doesNotMatch(activeConfig, /custom_domain\s*=/);
assert.doesNotMatch(activeConfig, /^\[vars\]$/m);
assert.doesNotMatch(activeConfig, /SUPABASE|TELEGRAM|MONZO|GOOGLE_OAUTH|SECRET|TOKEN|KV/i);

assert.match(config, /booking\.vishartattoo\.com/);
assert.match(worker, /booking\.vishartattoo\.com/);
assert.match(worker, /https:\/\/vishartattoo\.com/);
assert.match(worker, /https:\/\/tattooai\.vvetrov41\.workers\.dev\//);
assert.match(worker, /multipart_required/);
assert.match(worker, /Origin: UPSTREAM_ORIGIN/);
assert.doesNotMatch(worker, /JSON\.stringify\(parsed\.payload\)/);
assert.doesNotMatch(worker, /SUPABASE_SECRET_KEY|TELEGRAM_BOT_TOKEN|MONZO_CLIENT_SECRET|GOOGLE_OAUTH_CLIENT_SECRET/);

assert.match(releaseWorkflow, /release\/booking-host-rc\*/);
assert.match(releaseWorkflow, /environment: crm-production/);
assert.match(releaseWorkflow, /WORKER_NAME: vishar-booking-host-production/);
assert.match(releaseWorkflow, /git ls-remote --heads origin/);
assert.match(releaseWorkflow, /git merge-base --is-ancestor/);
assert.match(releaseWorkflow, /workers\/scripts\/\$\{WORKER_NAME\}/);
assert.match(releaseWorkflow, /body\.result\.bindings/);
assert.match(releaseWorkflow, /bindings\.length !== 0/);
assert.match(releaseWorkflow, /--dry-run/);
assert.match(releaseWorkflow, /npx wrangler deploy --config "\$PRODUCTION_CONFIG" --name "\$WORKER_NAME"/);
assert.match(releaseWorkflow, /Cloudflare deployment id did not change after deploy/);
assert.match(releaseWorkflow, /multipart_required/);
assert.doesNotMatch(releaseWorkflow, /supabase db push|supabase migration|wrangler secret put|routes?\s+(create|delete)|custom domain/i);

console.log('booking host production config tests passed');
