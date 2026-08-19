#!/usr/bin/env node
//
// Instagram production configuration boundary.
//
// The tracked Worker config is the intended state of a public Meta callback
// and an OAuth connector. This suite is what stops a release quietly widening
// that surface: a stray cron, a committed secret, a workers.dev hostname or a
// duplicated rate-limit namespace would all be caught here rather than in
// production.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'wrangler.instagram.production.toml');
const config = readFileSync(configPath, 'utf8');

let passes = 0;
let failures = 0;

function test(name, run) {
  try {
    run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

test('the Worker name and entry point are the reviewed ones', () => {
  assert.match(config, /^name = "vishar-instagram-production"$/m);
  assert.match(config, /^main = "workers\/instagram-production\.js"$/m);
});

test('no preview or workers.dev hostname is exposed', () => {
  assert.match(config, /^workers_dev = false$/m);
  assert.match(config, /^preview_urls = false$/m);
});

test('exactly one Custom Domain is declared, on the reviewed hostname', () => {
  const routes = config.match(/^routes = \[[\s\S]*?\]$/m);
  assert.ok(routes, 'routes block is present');
  const entries = routes[0].match(/\{[^}]*\}/g) ?? [];
  assert.equal(entries.length, 1);
  assert.match(entries[0], /pattern = "instagram\.vishartattoo\.com"/);
  assert.match(entries[0], /custom_domain = true/);
});

test('no cron trigger is declared in the tracked config', () => {
  // Adding a schedule is a release decision, made once Meta App Review and the
  // artist connections are actually in place. It must never arrive by accident
  // with a code change.
  assert.ok(!/\[triggers\]/.test(config));
  assert.ok(!/crons\s*=/.test(config));
});

test('every capability ships off', () => {
  for (const flag of [
    'INSTAGRAM_OAUTH_ENABLED',
    'INSTAGRAM_DRAIN_ENABLED',
    'INSTAGRAM_ENRICHMENT_ENABLED',
  ]) {
    assert.match(config, new RegExp(`^${flag} = "false"$`, 'm'), flag);
  }
});

test('the Supabase project is the production one', () => {
  assert.match(config, /^SUPABASE_URL = "https:\/\/vfjexhfdbrjmuxfdvbdx\.supabase\.co"$/m);
  assert.match(config, /^VISHAR_ENVIRONMENT = "production"$/m);
});

test('no secret or KV binding is committed', () => {
  for (const forbidden of [
    'INSTAGRAM_APP_SECRET =',
    'INSTAGRAM_TOKEN_ENCRYPTION_KEY =',
    'INSTAGRAM_WEBHOOK_VERIFY_TOKEN =',
    'SUPABASE_SECRET_KEY =',
    'SUPABASE_PUBLISHABLE_KEY =',
    '[[kv_namespaces]]',
  ]) {
    assert.ok(!config.includes(forbidden), forbidden);
  }
  // Nothing that looks like a Supabase or Meta credential value.
  assert.ok(!/sb_secret_[A-Za-z0-9]/.test(config));
  assert.ok(!/sb_publishable_[A-Za-z0-9]/.test(config));
  assert.ok(!/EAA[A-Za-z0-9]{20,}/.test(config));
});

test('no Service Binding to another Worker is declared', () => {
  // The connector runs its own scheduled work. Binding it into the live shared
  // cron Worker would put this workstream inside another deployment's blast
  // radius.
  assert.ok(!/\[\[services\]\]/.test(config));
});

test('the rate-limit namespace does not collide with another Worker', () => {
  const own = config.match(/namespace_id = "(\d+)"/);
  assert.ok(own, 'a rate limit namespace is declared');

  const collisions = readdirSync(root)
    .filter((name) => /^wrangler\..*\.toml$/.test(name) && name !== 'wrangler.instagram.production.toml')
    .filter((name) => readFileSync(join(root, name), 'utf8').includes(`namespace_id = "${own[1]}"`));
  assert.deepEqual(collisions, []);
});

test('the Worker source declares the same public host and redirect URI', () => {
  const source = readFileSync(join(root, 'workers/instagram-production.js'), 'utf8');
  assert.ok(source.includes("const INSTAGRAM_PUBLIC_HOST = 'instagram.vishartattoo.com'"));
  assert.ok(source.includes("const REDIRECT_URI = 'https://instagram.vishartattoo.com/oauth/instagram/callback'"));
});

test('the Worker source contains no credential-shaped literal', () => {
  for (const file of [
    'workers/instagram-production.js',
    'workers/lib/instagram.js',
    'workers/lib/instagram-webhook.js',
    'workers/lib/instagram-supabase.js',
    'workers/lib/communications-drain.js',
  ]) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.ok(!/sb_secret_[A-Za-z0-9]{8,}/.test(source), file);
    assert.ok(!/EAA[A-Za-z0-9]{20,}/.test(source), file);
    assert.ok(!/IGQ[A-Za-z0-9]{20,}/.test(source), file);
  }
});

test('the Instagram Graph version is pinned rather than tracking the newest', () => {
  const source = readFileSync(join(root, 'workers/lib/instagram.js'), 'utf8');
  assert.match(source, /export const INSTAGRAM_GRAPH_VERSION = 'v\d+\.\d+';/);
});

console.log(`instagram production config: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
