#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = await readFile(new URL('../wrangler.booking-host.production.toml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../workers/booking-host.js', import.meta.url), 'utf8');

assert.match(config, /^name = "vishar-booking-host-production"$/m);
assert.match(config, /^main = "workers\/booking-host\.js"$/m);
assert.match(config, /^workers_dev = false$/m);
assert.match(config, /^preview_urls = false$/m);
assert.match(config, /pattern = "booking\.vishartattoo\.com"/);
assert.match(config, /custom_domain = true/);
assert.equal((config.match(/pattern = /g) || []).length, 1);
assert.doesNotMatch(config, /\*\.vishartattoo\.com/);
assert.doesNotMatch(config, /^\[vars\]$/m);
assert.doesNotMatch(config, /SUPABASE|TELEGRAM|MONZO|GOOGLE_OAUTH|SECRET|TOKEN|KV/i);

assert.match(worker, /https:\/\/vishartattoo\.com/);
assert.match(worker, /https:\/\/tattooai\.vvetrov41\.workers\.dev\//);
assert.doesNotMatch(worker, /SUPABASE_SECRET_KEY|TELEGRAM_BOT_TOKEN|MONZO_CLIENT_SECRET|GOOGLE_OAUTH_CLIENT_SECRET/);

console.log('booking host production config tests passed');
