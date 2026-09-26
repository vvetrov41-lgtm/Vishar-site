// Audit M-8: public TattooAI per-IP rate limits and first-party API host.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import entry, { __testing, enforceSemanticPreflightRateLimit, rateLimitClass } from '../workers/tattooai-entry.js';

const { enforcePublicRateLimit } = __testing;

function limiter(allowed) {
  const calls = [];
  let used = 0;
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      used += 1;
      return { success: used <= allowed };
    },
  };
}

function request(method, ip, origin = 'https://vishartattoo.com') {
  const headers = new Headers({ Origin: origin });
  if (ip) headers.set('CF-Connecting-IP', ip);
  return new Request('https://api.vishartattoo.com/', { method, headers });
}

const env = { ALLOWED_ORIGINS: 'https://vishartattoo.com', VISHAR_ENVIRONMENT: 'production' };

assert.equal(rateLimitClass(request('OPTIONS', '1.2.3.4')), null, 'preflight is never counted');
assert.equal(rateLimitClass(request('POST', '1.2.3.4')), 'write');
assert.equal(rateLimitClass(request('POST', '1.2.3.4')), 'write');
assert.equal(rateLimitClass(new Request('https://api.vishartattoo.com/?preflight=1', {
  method: 'POST',
  headers: {
    Origin: 'https://vishartattoo.com',
    'CF-Connecting-IP': '1.2.3.4',
    'content-type': 'application/json',
  },
  body: '{}',
})), 'write', 'query marker alone never changes the generic request class');
assert.equal(rateLimitClass(request('GET', '1.2.3.4')), 'read');

{
  const write = limiter(0);
  const preflightBody = new FormData();
  preflightBody.set('preflight', '1');
  const preflight = new Request('https://api.vishartattoo.com/?preflight=1', {
    method: 'POST',
    headers: { Origin: 'https://vishartattoo.com', 'CF-Connecting-IP': '198.51.100.11' },
    body: preflightBody,
  });
  assert.equal(await enforcePublicRateLimit(preflight, { ...env, PUBLIC_WRITE_RATE_LIMIT: write }), null);
  assert.equal(write.calls.length, 0, 'semantic preflight does not spend final-submission capacity');

  const finalBody = new FormData();
  finalBody.set('name', 'Client');
  const disguisedFinal = new Request('https://api.vishartattoo.com/?preflight=1', {
    method: 'POST',
    headers: { Origin: 'https://vishartattoo.com', 'CF-Connecting-IP': '198.51.100.11' },
    body: finalBody,
  });
  const finalLimiter = limiter(0);
  const refused = await enforcePublicRateLimit(disguisedFinal, { ...env, PUBLIC_WRITE_RATE_LIMIT: finalLimiter });
  assert.equal(refused.status, 429, 'multipart query marker without body preflight remains a normal write');
  assert.deepEqual(finalLimiter.calls, ['write:198.51.100.11']);
}

{
  const write = limiter(2);
  const e = { ...env, PUBLIC_WRITE_RATE_LIMIT: write, PUBLIC_READ_RATE_LIMIT: limiter(100) };
  assert.equal(await enforcePublicRateLimit(request('POST', '198.51.100.7'), e), null);
  assert.equal(await enforcePublicRateLimit(request('POST', '198.51.100.7'), e), null);
  const refused = await enforcePublicRateLimit(request('POST', '198.51.100.7'), e);
  assert.equal(refused.status, 429, 'the third write in the window is refused');
  assert.deepEqual(await refused.json(), { ok: false, code: 'rate_limited' });
  assert.equal(refused.headers.get('access-control-allow-origin'), 'https://vishartattoo.com',
    'the browser can read the refusal and show it');
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.deepEqual(write.calls, ['write:198.51.100.7', 'write:198.51.100.7', 'write:198.51.100.7'],
    'keys carry only the class and the connecting IP');
}

{
  const write = limiter(0);
  const e = { ...env, PUBLIC_WRITE_RATE_LIMIT: write };
  assert.equal(await enforcePublicRateLimit(request('POST', '2a06:98c0:3600::103'), e), null,
    'first-party Worker proxies share one egress address and are not counted');
  assert.equal(write.calls.length, 0);
  assert.equal(await enforcePublicRateLimit(request('POST', null), e), null, 'no client address, no key');
}

{
  const failing = { async limit() { throw new Error('limiter down'); } };
  assert.equal(await enforcePublicRateLimit(request('POST', '198.51.100.8'), { ...env, PUBLIC_WRITE_RATE_LIMIT: failing }), null,
    'a failing limiter fails open');
  assert.equal(await enforcePublicRateLimit(request('POST', '198.51.100.8'), env), null, 'no binding, no limit');
}

{
  const semantic = limiter(1);
  const e = { ...env, INTAKE_PREFLIGHT_RATE_LIMIT: semantic };
  const directBody = new FormData();
  directBody.set('preflight', '1');
  const direct = new Request('https://api.vishartattoo.com/?preflight=1', {
    method: 'POST',
    headers: { Origin: 'https://vishartattoo.com', 'CF-Connecting-IP': '198.51.100.10' },
    body: directBody,
  });
  assert.equal(await enforceSemanticPreflightRateLimit(direct, e), null);
  const refused = await enforceSemanticPreflightRateLimit(direct, e);
  assert.equal(refused.status, 429);
  assert.deepEqual(semantic.calls, ['preflight:198.51.100.10', 'preflight:198.51.100.10']);

  const missing = await enforceSemanticPreflightRateLimit(direct, env);
  assert.equal(missing.status, 503, 'missing semantic limiter disables only the optional preflight');

  const workerBody = new FormData();
  workerBody.set('preflight', '1');
  const workerEgress = new Request('https://tattooai.vvetrov41.workers.dev/?preflight=1', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '2a06:98c0:3600::103' },
    body: workerBody,
  });
  assert.equal((await enforceSemanticPreflightRateLimit(workerEgress, env)).status, 503,
    'Worker egress is never exempt: without the limiter the paid preflight is unavailable');
  const shared = limiter(1);
  const egressEnv = { ...env, INTAKE_PREFLIGHT_RATE_LIMIT: shared };
  assert.equal(await enforceSemanticPreflightRateLimit(workerEgress, egressEnv), null);
  assert.equal((await enforceSemanticPreflightRateLimit(workerEgress, egressEnv)).status, 429,
    'any Cloudflare Worker (first-party or not) shares one bounded egress budget');
  assert.deepEqual(shared.calls, ['preflight:worker-egress', 'preflight:worker-egress']);
  const fakeJson = new Request('https://api.vishartattoo.com/?preflight=1', {
    method: 'POST',
    headers: {
      Origin: 'https://vishartattoo.com',
      'CF-Connecting-IP': '198.51.100.12',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(await enforceSemanticPreflightRateLimit(fakeJson, egressEnv), null);
  assert.deepEqual(shared.calls, ['preflight:worker-egress', 'preflight:worker-egress'],
    'non-multipart POSTs never consume or gain the semantic-preflight bucket');
  const disguisedBody = new FormData();
  disguisedBody.set('name', 'Client');
  const disguised = new Request('https://api.vishartattoo.com/?preflight=1', {
    method: 'POST',
    headers: { Origin: 'https://vishartattoo.com', 'CF-Connecting-IP': '198.51.100.13' },
    body: disguisedBody,
  });
  assert.equal(await enforceSemanticPreflightRateLimit(disguised, egressEnv), null);
  assert.deepEqual(shared.calls, ['preflight:worker-egress', 'preflight:worker-egress'],
    'body marker is required before the semantic limiter applies');
  const finalSubmit = new Request('https://tattooai.vvetrov41.workers.dev/', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '2a06:98c0:3600::103' },
  });
  assert.equal(await enforceSemanticPreflightRateLimit(finalSubmit, egressEnv), null,
    'a real submission is never subject to the semantic limiter');
}

{
  const e = { ...env, PUBLIC_WRITE_RATE_LIMIT: limiter(0), PUBLIC_READ_RATE_LIMIT: limiter(0) };
  const internal = new Request('https://tattooai.internal/internal/enquiry-ai/drain', {
    method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.9' },
  });
  const response = await entry.fetch(internal, { ...e, VISHAR_ENVIRONMENT: 'preview' }, { waitUntil() {} });
  assert.notEqual(response.status, 429, 'the internal Service Binding drain is dispatched before public limits');
}

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(toml, /routes = \[\n  \{ pattern = "api\.vishartattoo\.com", custom_domain = true \}\n\]/,
  'the first-party API host is a Custom Domain on the production Worker');
assert.match(toml, /^workers_dev = true$/m, 'workers.dev stays as the compatibility path');
assert.match(toml, /\[env\.preview\]\nworkers_dev = false\n(?:#[^\n]*\n)*routes = \[\]/,
  'preview never inherits the production Custom Domain');
assert.match(toml, /name = "PUBLIC_WRITE_RATE_LIMIT"\nnamespace_id = "1007"\nsimple = \{ limit = 20, period = 60 \}/);
assert.match(toml, /name = "PUBLIC_READ_RATE_LIMIT"\nnamespace_id = "1008"\nsimple = \{ limit = 300, period = 60 \}/);
assert.match(toml, /name = "INTAKE_PREFLIGHT_RATE_LIMIT"\nnamespace_id = "1012"\nsimple = \{ limit = 10, period = 60 \}/);

console.log('TattooAI public rate limits and first-party API host: passed.');
