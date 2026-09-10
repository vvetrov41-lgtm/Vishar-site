import assert from 'node:assert/strict';
import worker, { __testing } from '../workers/enquiry-ai-acceptance-probe.js';

const token = 'a'.repeat(64);
const calls = [];
const env = {
  PROBE_TOKEN: token,
  TATTOOAI_SERVICE: {
    async fetch(url, init = {}) {
      calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization') });
      return Response.json({ ok: true, processed: 1 });
    },
  },
};

for (const request of [
  new Request('https://probe.example.test/drain', { method: 'GET', headers: { authorization: `Bearer ${token}` } }),
  new Request('https://probe.example.test/drain?x=1', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
  new Request('https://probe.example.test/anything', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
  new Request('https://probe.example.test/drain', { method: 'POST' }),
  new Request('https://probe.example.test/drain', { method: 'POST', headers: { authorization: 'Bearer wrong' } }),
  new Request('https://probe.example.test/drain', {
    method: 'POST',
    headers: { authorization: `Bearer ${'b'.repeat(64)}` },
  }),
]) {
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 404);
}
assert.equal(calls.length, 0, 'unauthorized requests must not reach TattooAI');

const response = await worker.fetch(new Request('https://probe.example.test/drain', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
}), env);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { ok: true, processed: 1 });
assert.deepEqual(calls, [{
  url: __testing.AI_DRAIN_URL,
  method: 'POST',
  authorization: null,
}]);

const noBinding = await worker.fetch(new Request('https://probe.example.test/drain', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
}), { PROBE_TOKEN: token });
assert.equal(noBinding.status, 502);
assert.deepEqual(await noBinding.json(), {
  ok: false,
  processed: 0,
  errorCode: 'tattooai_service_binding_unavailable',
});

for (const invalid of [
  null,
  {},
  { ok: true, processed: -1 },
  { ok: true, processed: 4 },
  { ok: false, processed: 0 },
  { ok: false, processed: 0, errorCode: 'Private message' },
]) {
  assert.equal(__testing.normalizeSummary(invalid), null);
}
assert.deepEqual(__testing.normalizeSummary({ ok: false, processed: 0, errorCode: 'queue_unavailable' }), {
  ok: false,
  processed: 0,
  errorCode: 'queue_unavailable',
});

const originalLog = console.log;
const originalError = console.error;
let logged = false;
console.log = () => { logged = true; };
console.error = () => { logged = true; };
try {
  await worker.fetch(new Request('https://probe.example.test/drain', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  }), {
    PROBE_TOKEN: token,
    TATTOOAI_SERVICE: { async fetch() { throw new Error('private body'); } },
  });
} finally {
  console.log = originalLog;
  console.error = originalError;
}
assert.equal(logged, false, 'probe must never log client or provider content');

console.log('Enquiry AI acceptance probe tests passed: ephemeral auth and bounded service-only drain expose no client data.');
