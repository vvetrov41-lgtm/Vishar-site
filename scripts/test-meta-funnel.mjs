#!/usr/bin/env node

import assert from 'node:assert/strict';
import tattooaiEntry from '../workers/tattooai-entry.js';
import {
  handleMetaFunnelRequest,
  isMetaFunnelPath,
  projectFunnel,
  signingInput,
} from '../workers/routes/meta-funnel.js';
import { ALLOWED_RPCS, META_FUNNEL_RPCS, READ_ONLY_RPCS } from '../workers/lib/supabase.js';

const ACCOUNT = 'act_2128002004809955';
const KEY = 'k'.repeat(40);
const NOW = 1_793_500_000;
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'legacy-test-key',
  META_FUNNEL_KEYS: JSON.stringify({ [ACCOUNT]: KEY }),
};

let passes = 0;
let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${error.stack || error.message}`);
  }
}

async function sign(key, ts, account, since, until) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(signingInput(ts, account, since, until)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const DB_PAYLOAD = {
  version: 1,
  account_id: ACCOUNT,
  currency: 'GBP',
  date_basis: 'meta_account_local',
  rows: [
    { date: '2026-10-25', ad_id: '120248212423350778', campaign_id: '120247800617380778', enquiries: 4, consultations: null, confirmed_projects: 0, deposits_count: 0, deposits_minor: 0 },
  ],
};

function backend(payload = DB_PAYLOAD, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ href: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/rest/v1/rpc/service_meta_crm_funnel')) {
      return status === 200 ? Response.json(payload) : new Response('{}', { status });
    }
    throw new Error(`unexpected backend call: ${url}`);
  };
  return { calls, fetchImpl };
}

async function request({ account = ACCOUNT, since = '2026-10-01', until = '2026-10-31', ts = NOW, key = KEY, method = 'GET', extra = '', signature } = {}) {
  const sig = signature ?? await sign(key, ts, account, since, until);
  return new Request(`https://tattooai.example/internal/meta-funnel?account_id=${account}&since=${since}&until=${until}${extra}`, {
    method,
    headers: { 'x-vishar-timestamp': String(ts), 'x-vishar-signature': sig },
  });
}

await test('route is only the exact internal path', async () => {
  assert.equal(isMetaFunnelPath(new Request('https://tattooai.example/internal/meta-funnel?x=1')), true);
  assert.equal(isMetaFunnelPath(new Request('https://tattooai.example/internal/meta-funnel/x')), false);
});

await test('RPC is in its own allow-list, never in the intake or public read lists', async () => {
  assert.equal(META_FUNNEL_RPCS.has('service_meta_crm_funnel'), true);
  assert.equal(ALLOWED_RPCS.has('service_meta_crm_funnel'), false);
  assert.equal(READ_ONLY_RPCS.has('service_meta_crm_funnel'), false);
});

await test('a signed request returns only the contract fields; the account is passed as digits', async () => {
  const { calls, fetchImpl } = backend({ ...DB_PAYLOAD, rows: [{ ...DB_PAYLOAD.rows[0], email: 'x@example.test', client_name: 'X' }] });
  const res = await handleMetaFunnelRequest(await request(), env, { fetchImpl, now: () => NOW });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const body = await res.json();
  assert.deepEqual(body.rows[0], DB_PAYLOAD.rows[0]);
  assert.ok(!JSON.stringify(body).includes('example.test'));
  assert.deepEqual(calls[0].body, { p_ad_account_id: '2128002004809955', p_since: '2026-10-01', p_until: '2026-10-31' });
});

await test('full months expose only suppressed campaign totals; partial ranges reject them', async () => {
  const row = { campaign_id: '120247800617380778', enquiries: 3, consultations: null,
    confirmed_projects: 0, deposits_count: 0, deposits_minor: 0, client_name: 'remove me' };
  const { fetchImpl } = backend({ ...DB_PAYLOAD, campaign_totals: [row] });
  const response = await handleMetaFunnelRequest(await request(), env, { fetchImpl, now: () => NOW });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.campaign_totals, [{ campaign_id: row.campaign_id, enquiries: 3,
    consultations: null, confirmed_projects: 0, deposits_count: 0, deposits_minor: 0 }]);
  assert.ok(!JSON.stringify(data).includes('remove me'));
  const partial = await handleMetaFunnelRequest(
    await request({ since: '2026-10-01', until: '2026-10-30' }), env, { fetchImpl, now: () => NOW });
  assert.equal(partial.status, 502);
  for (const bad of [
    { ...row, enquiries: 1 },
    { ...row, deposits_count: null, deposits_minor: 15000 },
    { ...row, campaign_id: 'invalid' },
  ]) {
    const result = await handleMetaFunnelRequest(await request(), env,
      { ...backend({ ...DB_PAYLOAD, campaign_totals: [bad] }), now: () => NOW });
    assert.equal(result.status, 502);
  }
});

await test('unauthenticated, replayed, malformed or unconfigured requests are 404 and never reach the database', async () => {
  const cases = [
    await request({ signature: '0'.repeat(64) }),
    await request({ key: 'w'.repeat(40) }),
    await request({ ts: NOW - 301 }),
    await request({ ts: NOW + 301 }),
    await request({ method: 'POST' }),
    await request({ extra: '&artist=kristina' }),
    await request({ account: 'act_899170029105750' }), // no key for this account
    await request({ since: '2026-10-31', until: '2026-10-01' }),
    await request({ since: '2026-07-01', until: '2026-10-31' }), // over 90 days
    await request({ since: '2026-02-30' }),
    await request({ signature: '' }),
  ];
  for (const req of cases) {
    const { calls, fetchImpl } = backend();
    const res = await handleMetaFunnelRequest(req, env, { fetchImpl, now: () => NOW });
    assert.equal(res.status, 404, req.url);
    assert.equal(calls.length, 0);
  }
  for (const keys of [undefined, 'not json', JSON.stringify({ [ACCOUNT]: 'short' }), JSON.stringify([KEY])]) {
    const { calls, fetchImpl } = backend();
    const res = await handleMetaFunnelRequest(await request(), { ...env, META_FUNNEL_KEYS: keys }, { fetchImpl, now: () => NOW });
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0);
  }
});

await test('database failures and unexpected shapes are reported as unavailable, not as zero', async () => {
  let r = await handleMetaFunnelRequest(await request(), env, { ...backend(DB_PAYLOAD, 503), now: () => NOW });
  assert.equal(r.status, 503);
  for (const bad of [
    { ...DB_PAYLOAD, account_id: 'act_899170029105750' },
    { ...DB_PAYLOAD, rows: [{ ...DB_PAYLOAD.rows[0], enquiries: -1 }] },
    { ...DB_PAYLOAD, rows: [{ ...DB_PAYLOAD.rows[0], ad_id: 120248212423350778 }] },
    { ...DB_PAYLOAD, version: 2 },
  ]) {
    r = await handleMetaFunnelRequest(await request(), env, { ...backend(bad), now: () => NOW });
    assert.equal(r.status, 502);
  }
  assert.equal(projectFunnel(null, ACCOUNT), null);
});

await test('the production entry dispatches the path before the legacy router', async () => {
  const res = await tattooaiEntry.fetch(new Request('https://tattooai.example/internal/meta-funnel'), { ...env, META_FUNNEL_KEYS: undefined }, { waitUntil() {} });
  assert.equal(res.status, 404);
});

console.log(`meta funnel: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
