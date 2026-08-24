#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = await readFile(new URL('../wrangler.booking-host.production.toml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../workers/booking-host.js', import.meta.url), 'utf8');
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

console.log('booking host production config tests passed');
