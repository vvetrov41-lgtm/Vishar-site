import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const deployReady = process.argv.includes('--deploy-ready');
const configPath = resolve(process.cwd(), 'wrangler.calendar.staging.toml');
const source = readFileSync(configPath, 'utf8');
const active = source
  .split(/\r?\n/)
  .map((line) => line.replace(/\s+#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');

function exactValue(key) {
  const match = active.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`, 'm'));
  return match?.[1] ?? null;
}

function crmUrl(key, allowedHashes) {
  const value = exactValue(key);
  assert.ok(value, `${key} is required`);
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${key} must use HTTPS`);
  assert.equal(url.hostname, 'vishar-crm-staging.pages.dev', `${key} has an unexpected host`);
  assert.equal(url.pathname, '/', `${key} must preserve the hash-router root path`);
  assert.equal(url.username, '', `${key} must not contain credentials`);
  assert.equal(url.password, '', `${key} must not contain credentials`);
  assert.equal(url.search, '', `${key} must not contain a committed query string`);
  assert.ok(allowedHashes.includes(url.hash), `${key} has an unexpected CRM hash route`);
  return url;
}

assert.equal(exactValue('name'), 'vishar-calendar-staging', 'unexpected Worker name');
assert.equal(exactValue('main'), 'workers/calendar-oauth.js', 'unexpected Worker entrypoint');
assert.match(active, /^workers_dev\s*=\s*false$/m, 'workers.dev must remain disabled');
assert.equal(
  (active.match(/^\[triggers\]$/gm) || []).length,
  1,
  'exactly one cron trigger block is required',
);
const cronMatch = active.match(/^crons\s*=\s*\[\s*"([^"]+)"\s*\]$/m);
assert.equal(cronMatch?.[1], '*/5 * * * *', 'unexpected Calendar drain schedule');
assert.equal(exactValue('CALENDAR_DRAIN_ENABLED'), 'true', 'staging Calendar drain must be enabled');
assert.ok(!/vishartattoo\.com(?![^\n]*calendar-staging)/i.test(
  active.replace(/calendar-staging\.vishartattoo\.com/g, ''),
), 'production host found in staging configuration');

const routeMatches = [...active.matchAll(/\{\s*pattern\s*=\s*"([^"]+)"\s*,\s*custom_domain\s*=\s*true\s*\}/g)];
assert.equal(routeMatches.length, 1, 'exactly one custom-domain route is required');
assert.equal(routeMatches[0][1], 'calendar-staging.vishartattoo.com', 'unexpected custom domain');
assert.equal(
  exactValue('GOOGLE_OAUTH_REDIRECT_URI'),
  'https://calendar-staging.vishartattoo.com/oauth/google/callback',
  'OAuth redirect URI must be exact',
);
assert.equal(
  exactValue('CALENDAR_ACCESS_TEAM_DOMAIN'),
  'https://vishar-site-pages.cloudflareaccess.com',
  'Cloudflare Access team domain must be exact',
);
assert.equal(
  exactValue('CALENDAR_ACCESS_AUD'),
  '2a0569d2cc1acb785ccf190585be7ca9cad70fe6db7042a8094bf39160a26013',
  'Cloudflare Access application AUD must be exact',
);
assert.equal(exactValue('CALENDAR_OWNER_EMAILS'), 'vvetrov41@gmail.com', 'unexpected owner allowlist');
assert.equal(
  exactValue('VLADIMIR_ARTIST_ID'),
  'a1111111-1111-4111-8111-111111111111',
  'unexpected Vladimir artist ID',
);
assert.equal(exactValue('VLADIMIR_GOOGLE_EMAIL'), 'vvetrov41@gmail.com', 'unexpected Vladimir account');
assert.equal(
  exactValue('KRISTINA_ARTIST_ID'),
  'a2222222-2222-4222-8222-222222222222',
  'unexpected Kristina artist ID',
);
assert.equal(exactValue('KRISTINA_GOOGLE_EMAIL'), 'tinaakaten@gmail.com', 'unexpected Kristina account');
assert.equal(
  exactValue('SUPABASE_URL'),
  'https://gwaliusblwrzisrwnsvs.supabase.co',
  'unexpected Supabase project URL',
);
crmUrl('CRM_RETURN_URL', ['#/appointments', '#/integrations/calendar']);
crmUrl('CRM_APPOINTMENTS_URL', ['#/appointments']);

const bindings = [...active.matchAll(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"([^"]+)"[\s\S]*?id\s*=\s*"([^"]+)"/g)]
  .map((match) => ({ binding: match[1], id: match[2] }));
if (bindings.length > 0) {
  assert.equal(bindings.length, 2, 'exactly two KV bindings are required when configured');
  assert.deepEqual(
    bindings.map((item) => item.binding).sort(),
    ['CALENDAR_OAUTH_STATE', 'CALENDAR_OAUTH_TOKENS'],
  );
  assert.notEqual(bindings[0].id, bindings[1].id, 'KV namespaces must be distinct');
  for (const item of bindings) {
    assert.match(item.id, /^[0-9a-f]{32}$/i, `${item.binding} namespace ID is invalid`);
  }
}
if (deployReady) assert.equal(bindings.length, 2, 'deploy-ready mode requires both KV namespace IDs');

const result = {
  mode: deployReady ? 'deploy-ready' : 'offline',
  configured: {
    worker: true,
    customDomain: true,
    oauthRedirect: true,
    crmReturn: true,
    crmAppointments: true,
    accessTeamDomain: true,
    accessAudience: true,
    ownerAllowlist: true,
    artists: true,
    supabase: true,
    kvBindings: bindings.length === 2,
    scheduledDrain: true,
    drainSchedule: cronMatch[1],
    drainLimit: 10,
    workersDev: false,
  },
};
console.log(JSON.stringify(result));
