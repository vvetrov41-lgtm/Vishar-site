#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  __testing as productionTesting,
  handleProductionBookingHostRequest,
  isAppointmentActionNamespace,
  isValidAppointmentActionPath,
} from '../workers/booking-host-production.js';

const config = await readFile(new URL('../wrangler.booking-host.production.toml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../workers/booking-host.js', import.meta.url), 'utf8');
const productionWorker = await readFile(new URL('../workers/booking-host-production.js', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(new URL('../.github/workflows/deploy-production-booking-host.yml', import.meta.url), 'utf8');
const privateReleaseWorkflow = await readFile(new URL('../.github/workflows/private-production-release.yml', import.meta.url), 'utf8');
const privateReleaseObserver = await readFile(new URL('../.github/workflows/private-production-release-observer.yml', import.meta.url), 'utf8');
const activeConfig = config
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

assert.match(activeConfig, /^name = "vishar-booking-host-production"$/m);
assert.match(activeConfig, /^main = "workers\/booking-host-production\.js"$/m);
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

assert.equal(productionTesting.HOST, 'booking.vishartattoo.com');
assert.equal(productionTesting.ACTION_UPSTREAM_ORIGIN, 'https://telegram.vishartattoo.com');
assert.equal(productionTesting.ACTION_NAMESPACE_PREFIX, '/appointments/respond/');
assert.match(productionWorker, /handleBookingHostRequest/);
assert.match(productionWorker, /https:\/\/telegram\.vishartattoo\.com/);
assert.doesNotMatch(
  productionWorker,
  /SUPABASE_SECRET_KEY|TELEGRAM_BOT_TOKEN|MONZO_CLIENT_SECRET|GOOGLE_OAUTH_CLIENT_SECRET|Authorization:/,
);

const token = 'a'.repeat(64);
const actionPath = `/appointments/respond/${token}`;
assert.equal(isAppointmentActionNamespace(actionPath), true);
assert.equal(isAppointmentActionNamespace('/appointments/other'), false);
assert.equal(isValidAppointmentActionPath(actionPath), true);
assert.equal(isValidAppointmentActionPath(`${actionPath}/`), true);
for (const invalid of [
  '/appointments/respond/not-a-token',
  `/appointments/respond/${'A'.repeat(64)}`,
  `/appointments/respond/${token}x`,
  `${actionPath}/extra`,
]) {
  assert.equal(isAppointmentActionNamespace(invalid), true);
  assert.equal(isValidAppointmentActionPath(invalid), false);
}

const actionCalls = [];
const actionFetch = async (url, init = {}) => {
  actionCalls.push({ url: String(url), init });
  if (init.method === 'POST') {
    return new Response('<!doctype html><title>Attendance confirmed</title><h1>Attendance confirmed</h1>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        'content-security-policy': "default-src 'none'; form-action 'self'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'x-robots-tag': 'noindex, nofollow, noarchive',
      },
    });
  }
  return new Response('<!doctype html><title>Link unavailable</title><h1>This link is unavailable</h1>', {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'content-security-policy': "default-src 'none'; form-action 'self'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'set-cookie': 'must-not-cross=1',
    },
  });
};

const malformed = await handleProductionBookingHostRequest(
  new Request('https://booking.vishartattoo.com/appointments/respond/not-a-token'),
  { fetchImpl: actionFetch },
);
assert.equal(malformed.status, 404);
assert.equal(actionCalls.length, 0);

const methodBlocked = await handleProductionBookingHostRequest(
  new Request(`https://booking.vishartattoo.com${actionPath}`, { method: 'PUT' }),
  { fetchImpl: actionFetch },
);
assert.equal(methodBlocked.status, 405);
assert.equal(methodBlocked.headers.get('allow'), 'GET, HEAD, POST, OPTIONS');
assert.equal(actionCalls.length, 0);

const getResponse = await handleProductionBookingHostRequest(
  new Request(`https://booking.vishartattoo.com${actionPath}?utm_source=mail`, {
    headers: {
      Cookie: 'browser-cookie=private',
      Authorization: 'Bearer browser-token',
      Origin: 'https://attacker.example',
    },
  }),
  { fetchImpl: actionFetch },
);
assert.equal(getResponse.status, 404);
assert.match(await getResponse.text(), /This link is unavailable/);
assert.equal(getResponse.headers.get('cache-control'), 'no-store, max-age=0');
assert.equal(getResponse.headers.get('referrer-policy'), 'no-referrer');
assert.equal(getResponse.headers.get('set-cookie'), null);
assert.equal(actionCalls.length, 1);
assert.equal(actionCalls[0].url, `https://telegram.vishartattoo.com${actionPath}`);
assert.equal(actionCalls[0].init.method, 'GET');
assert.equal(actionCalls[0].init.redirect, 'manual');
assert.equal(actionCalls[0].init.headers.Cookie, undefined);
assert.equal(actionCalls[0].init.headers.Authorization, undefined);
assert.equal(actionCalls[0].init.headers.Origin, undefined);

const postResponse = await handleProductionBookingHostRequest(
  new Request(`https://booking.vishartattoo.com${actionPath}`, {
    method: 'POST',
    body: 'browser-body-must-not-forward',
  }),
  { fetchImpl: actionFetch },
);
assert.equal(postResponse.status, 200);
assert.match(await postResponse.text(), /Attendance confirmed/);
assert.equal(actionCalls.length, 2);
assert.equal(actionCalls[1].url, `https://telegram.vishartattoo.com${actionPath}`);
assert.equal(actionCalls[1].init.method, 'POST');
assert.equal(actionCalls[1].init.body, undefined);

const wrongHost = await handleProductionBookingHostRequest(
  new Request(`https://evil.example${actionPath}`),
  { fetchImpl: actionFetch },
);
assert.equal(wrongHost.status, 404);
assert.equal(actionCalls.length, 2);

const bookingReleasePattern = 'release/private-crm-rc*-booking-host*';
const bookingReleaseExclusion = "- '!release/private-crm-rc*-booking-host*'";
assert.match(releaseWorkflow, /release\/private-crm-rc\*-booking-host\*/);
assert.doesNotMatch(releaseWorkflow, /release\/booking-host-rc\*/);
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

assert.equal(releaseWorkflow.includes(bookingReleasePattern), true);
assert.equal(privateReleaseWorkflow.includes(bookingReleaseExclusion), true);
assert.equal(privateReleaseObserver.includes(bookingReleaseExclusion), true);
assert.match(privateReleaseWorkflow, /release\/private-crm-rc\*-booking-host\*\)\s*(?:\n|.)*?exit 1/);
assert.match(privateReleaseObserver, /release\/private-crm-rc\*-booking-host\*\) exit 1/);

console.log('booking host production config, release admission and appointment proxy tests passed');
