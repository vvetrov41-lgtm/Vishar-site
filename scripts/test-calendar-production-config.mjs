import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildDeployConfig,
  preserveExactRoute,
  readInputs,
} from './generate-calendar-production-deploy-config.mjs';

/**
 * The generator is the only thing standing between the tracked, deliberately
 * non-deployable production configuration and a live production Worker. Without
 * behavioural coverage a regression in it would first surface during the actual
 * production deploy, so every guarantee it makes is exercised here.
 *
 * The identifiers below are synthetic and structurally valid. They are never
 * real Cloudflare or Supabase objects.
 */

let passes = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

const canonical = readFileSync(
  resolve(process.cwd(), 'wrangler.calendar.production.toml'),
  'utf8',
);

const SYNTHETIC = {
  SUPABASE_URL: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co',
  CALENDAR_ACCESS_AUD: 'a'.repeat(64),
  CALENDAR_KV_STATE_ID: 'b'.repeat(32),
  CALENDAR_KV_TOKENS_ID: 'c'.repeat(32),
};

const RETAINED_STAGING = {
  supabaseUrl: 'https://gwaliusblwrzisrwnsvs.supabase.co',
  accessAud: '2a0569d2cc1acb785ccf190585be7ca9cad70fe6db7042a8094bf39160a26013',
  kvStateId: 'dd43224461504e898addeba5b7915142',
  kvTokensId: '93302bc4f35242c38358a16fcd4ab9a2',
};

const generate = (overrides = {}, source = canonical) =>
  buildDeployConfig(source, readInputs({ ...SYNTHETIC, ...overrides }));

const directivesOf = (text) => text
  .split(/\r?\n/)
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');

await test('the tracked canonical config is not directly deployable', () => {
  const active = directivesOf(canonical);
  assert.doesNotMatch(active, /^SUPABASE_URL\s*=/m);
  assert.doesNotMatch(active, /^CALENDAR_ACCESS_AUD\s*=/m);
  assert.doesNotMatch(active, /^\[\[kv_namespaces\]\]$/m);
});

await test('the exact pre-provisioned Custom Domain route is normalized for strict deploy', () => {
  const generated = generate();
  const active = directivesOf(generated);
  assert.match(active, /^routes\s*=\s*\[$/m);
  assert.match(active, /pattern\s*=\s*"calendar\.vishartattoo\.com"/);
  assert.match(active, /zone_name\s*=\s*"vishartattoo\.com"/);
  assert.match(active, /custom_domain\s*=\s*true/);
  assert.match(active, /enabled\s*=\s*true/);
  assert.match(active, /previews_enabled\s*=\s*false/);
  assert.equal(
    (active.match(/pattern\s*=\s*"calendar\.vishartattoo\.com"/g) || []).length,
    1,
  );
  assert.doesNotMatch(
    active,
    /\{\s*pattern\s*=\s*"calendar\.vishartattoo\.com"\s*,\s*custom_domain\s*=\s*true\s*\}/,
    'the deploy artefact must not retain the metadata-incomplete route form',
  );
});

await test('route drift fails closed before deploy config generation', () => {
  const cases = [
    canonical.replace('calendar.vishartattoo.com', 'calendar-other.vishartattoo.com'),
    canonical.replace('custom_domain = true', 'custom_domain = false'),
    canonical.replace(/^routes = \[$/m, 'routes_disabled = ['),
    canonical.replace(
      '  { pattern = "calendar.vishartattoo.com", custom_domain = true }',
      '  { pattern = "calendar.vishartattoo.com", custom_domain = true },\n  { pattern = "calendar-extra.vishartattoo.com", custom_domain = true }',
    ),
  ];
  for (const source of cases) {
    assert.throws(
      () => preserveExactRoute(source),
      /production Custom Domain/,
    );
  }
});

await test('the generated deploy route metadata is fixed and cannot be inherited from tracked drift', () => {
  const generated = generate();
  const routeLine = directivesOf(generated)
    .split('\n')
    .find((line) => line.includes('pattern = "calendar.vishartattoo.com"'));
  assert.equal(
    routeLine,
    '{ pattern = "calendar.vishartattoo.com", zone_name = "vishartattoo.com", custom_domain = true, enabled = true, previews_enabled = false }',
  );
  assert.throws(
    () => preserveExactRoute(canonical.replace('custom_domain = true', 'custom_domain = true, enabled = false')),
    /production Custom Domain/,
  );
});

await test('the injected values land inside [vars] and as KV table arrays', () => {
  const active = directivesOf(generate());
  assert.match(active, /^SUPABASE_URL = "https:\/\/vfjexhfdbrjmuxfdvbdx\.supabase\.co"$/m);
  assert.match(active, new RegExp(`^CALENDAR_ACCESS_AUD = "${'a'.repeat(64)}"$`, 'm'));
  assert.equal((active.match(/^\[\[kv_namespaces\]\]$/gm) || []).length, 2);
  assert.match(active, /^binding = "CALENDAR_OAUTH_STATE"$/m);
  assert.match(active, /^binding = "CALENDAR_OAUTH_TOKENS"$/m);
  assert.match(active, new RegExp(`^id = "${'b'.repeat(32)}"$`, 'm'));
  assert.match(active, new RegExp(`^id = "${'c'.repeat(32)}"$`, 'm'));

  // `[vars]` must remain the last canonical table before injected KV arrays,
  // otherwise the bare production values could be captured by another table.
  const tables = [...active.matchAll(/^(\[\[?[^\]]+\]\]?)$/gm)].map((m) => m[1]);
  assert.equal(tables.filter((t) => t === '[vars]').length, 1);
  assert.ok(tables.indexOf('[vars]') < tables.indexOf('[[kv_namespaces]]'));
});

await test('the generated runtime stays doubly inert and privately exposed', () => {
  const active = directivesOf(generate());
  assert.match(active, /^CALENDAR_DRAIN_ENABLED = "false"$/m);
  assert.doesNotMatch(active, /^\[triggers\]$/m);
  assert.doesNotMatch(active, /^crons\s*=/m);
  assert.match(active, /^workers_dev = false$/m);
  assert.match(active, /^preview_urls = false$/m);
  assert.match(active, /^\[\[ratelimits\]\]$/m);
  assert.match(active, /^name = "CALENDAR_RATE_LIMIT"$/m);
});

await test('retained staging identifiers are refused, one axis at a time', () => {
  const cases = [
    ['SUPABASE_URL', RETAINED_STAGING.supabaseUrl, /retained staging Supabase project/],
    ['CALENDAR_ACCESS_AUD', RETAINED_STAGING.accessAud, /retained staging Calendar Access audience/],
    ['CALENDAR_KV_STATE_ID', RETAINED_STAGING.kvStateId, /retained staging Calendar KV namespace/],
    ['CALENDAR_KV_TOKENS_ID', RETAINED_STAGING.kvTokensId, /retained staging Calendar KV namespace/],
  ];
  for (const [name, value, message] of cases) {
    assert.throws(() => generate({ [name]: value }), message, `${name} must be refused`);
  }
});

await test('the PKCE state and token stores may never be the same namespace', () => {
  assert.throws(
    () => generate({ CALENDAR_KV_TOKENS_ID: SYNTHETIC.CALENDAR_KV_STATE_ID }),
    /must not share one KV namespace/,
  );
});

await test('missing or malformed inputs fail closed', () => {
  const cases = [
    [{ SUPABASE_URL: '' }, /supabaseUrl is not configured/],
    [{ CALENDAR_ACCESS_AUD: '' }, /accessAud is not configured/],
    [{ CALENDAR_KV_STATE_ID: '' }, /kvStateId is not configured/],
    [{ CALENDAR_KV_TOKENS_ID: '' }, /kvTokensId is not configured/],
    [{ SUPABASE_URL: 'http://vfjexhfdbrjmuxfdvbdx.supabase.co' }, /exact hosted Supabase project root/],
    [{ SUPABASE_URL: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co/rest' }, /exact hosted Supabase project root/],
    [{ SUPABASE_URL: 'https://evil.example.com' }, /exact hosted Supabase project root/],
    [{ CALENDAR_ACCESS_AUD: 'deadbeef' }, /64-character Access audience tag/],
    [{ CALENDAR_ACCESS_AUD: `${'A'.repeat(64)}` }, /64-character Access audience tag/],
    [{ CALENDAR_KV_STATE_ID: 'short' }, /32-character KV namespace id/],
    [{ CALENDAR_KV_TOKENS_ID: `${'z'.repeat(32)}` }, /32-character KV namespace id/],
  ];
  for (const [overrides, message] of cases) {
    assert.throws(() => generate(overrides), message, `${JSON.stringify(overrides)} must be refused`);
  }
});

await test('a canonical config whose last table is not [vars] is refused', () => {
  assert.throws(
    () => generate({}, `${canonical}\n[triggers]\ncrons = ["*/5 * * * *"]\n`),
    /must be the final table in the canonical production config/,
  );
});

await test('a canonical config that re-enables exposure is refused', () => {
  assert.throws(
    () => generate({}, canonical.replace('workers_dev = false', 'workers_dev = true')),
    /workers\.dev must remain disabled/,
  );
  assert.throws(
    () => generate({}, canonical.replace('preview_urls = false', 'preview_urls = true')),
    /preview URLs must remain disabled/,
  );
  assert.throws(
    () => generate({}, canonical.replace('CALENDAR_DRAIN_ENABLED = "false"', 'CALENDAR_DRAIN_ENABLED = "true"')),
    /lost the disabled Calendar drain/,
  );
});

await test('a canonical config that drops the isolated limiter is refused', () => {
  assert.throws(
    () => generate({}, canonical.replace('[[ratelimits]]', '[[disabled_ratelimits]]')),
    /lost the isolated Worker rate limiter/,
  );
});

if (failures > 0) {
  console.error(`Calendar production config generator: ${passes} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`Calendar production config generator: ${passes} passed`);
