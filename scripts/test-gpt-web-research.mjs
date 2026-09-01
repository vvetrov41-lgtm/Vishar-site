import assert from 'node:assert/strict';
import { handleGptWebResearchRequest } from '../workers/lib/gpt-web-research.js';

const oauthToken = 'header.payload.signature';
const firecrawlKey = 'fc-test-provider-key-not-a-real-secret';
const env = {
  GPT_ACTIONS_ENABLED: 'true',
  WEB_RESEARCH_ENABLED: 'true',
  WEB_RESEARCH_SEARCH_ENABLED: 'true',
  WEB_RESEARCH_SCRAPE_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
  FIRECRAWL_API_KEY: firecrawlKey,
};

function request(path, body, init = {}) {
  return new Request(`https://gpt-operations.vishartattoo.com${path}`, {
    method: init.method || 'POST',
    headers: {
      authorization: `Bearer ${oauthToken}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
    body: ['GET', 'HEAD'].includes(init.method) ? undefined : JSON.stringify(body),
  });
}

function authOk() {
  return new Response(JSON.stringify({ allowed: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

{
  let called = false;
  const result = await handleGptWebResearchRequest(
    request('/v1/appointments', {}), env, async () => { called = true; },
  );
  assert.equal(result, null, 'non-web routes must fall through to the existing GPT handler');
  assert.equal(called, false);
}

{
  let called = false;
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'disabled research' }),
    { ...env, WEB_RESEARCH_ENABLED: 'false' },
    async () => { called = true; },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(called, false, 'global Web Research kill switch must fail before auth/provider subrequests');
}

{
  let called = false;
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'disabled search' }),
    { ...env, WEB_RESEARCH_SEARCH_ENABLED: 'false' },
    async () => { called = true; },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(called, false, 'search kill switch must fail before auth/provider subrequests');
}

{
  let called = false;
  const response = await handleGptWebResearchRequest(
    request('/v1/web/scrape', { url: 'https://example.com/' }),
    { ...env, WEB_RESEARCH_SCRAPE_ENABLED: 'false' },
    async () => { called = true; },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(called, false, 'scrape kill switch must fail before auth/provider subrequests');
}

{
  let called = false;
  const response = await handleGptWebResearchRequest(
    new Request('https://gpt-operations.vishartattoo.com/v1/web/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'tattoo aftercare' }),
    }),
    env,
    async () => { called = true; },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'oauth_token_required' });
  assert.equal(called, false, 'missing OAuth must fail before Supabase or Firecrawl');
}

{
  let called = false;
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'test', provider: 'attacker' }),
    env,
    async () => { called = true; },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_field', field: 'provider' });
  assert.equal(called, false, 'caller-selected provider routing must fail before any subrequest');
}

{
  const calls = [];
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'cover up tattoo' }),
    env,
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ code: '42501', message: 'raw private policy detail' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'web_research_not_permitted' });
  assert.equal(calls.length, 1, 'capability denial must happen before provider call');
  assert.equal(calls[0].url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_authorize_web_research');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${oauthToken}`);
  assert.equal(calls[0].init.redirect, 'manual');
}

{
  const calls = [];
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'cover up tattoo' }),
    { ...env, FIRECRAWL_API_KEY: undefined },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return authOk();
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'web_research_provider_unavailable' });
  assert.equal(calls.length, 1, 'missing provider secret fails closed after CRM authorization');
}

{
  const calls = [];
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'best tattoo cover up advice', limit: 2 }),
    env,
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return authOk();
      return new Response(JSON.stringify({
        success: true,
        data: {
          web: [
            { title: 'Useful result', url: 'https://example.com/guide', description: 'Public evidence' },
            { title: 'Second result', url: 'https://example.org/article', description: 'More evidence' },
            { title: 'Extra result', url: 'https://example.net/extra', description: 'Must be capped' },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 2);
  assert.match(body.notice, /untrusted/i);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(calls[1].init.headers.authorization, `Bearer ${firecrawlKey}`);
  assert.notEqual(calls[1].init.headers.authorization, `Bearer ${oauthToken}`,
    'caller OAuth must never be forwarded to Firecrawl');
  assert.equal(calls[1].init.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    query: 'best tattoo cover up advice',
    limit: 2,
    sources: [{ type: 'web' }],
    safe: true,
  });
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(oauthToken), false);
  assert.equal(serialized.includes(firecrawlKey), false);
}

for (const unsafeUrl of [
  'file:///etc/passwd',
  'http://localhost/admin',
  'http://127.0.0.1/',
  'http://10.1.2.3/',
  'http://169.254.169.254/latest/meta-data',
  'http://172.20.1.2/',
  'http://192.168.1.1/',
  'http://user:pass@example.com/',
  'http://[::1]/',
]) {
  let called = false;
  const response = await handleGptWebResearchRequest(
    request('/v1/web/scrape', { url: unsafeUrl }), env,
    async () => { called = true; },
  );
  assert.equal(response.status, 400, `unsafe URL must be rejected: ${unsafeUrl}`);
  assert.equal(called, false, 'unsafe scrape target must fail before authorization/provider calls');
}

{
  const calls = [];
  const response = await handleGptWebResearchRequest(
    request('/v1/web/scrape', { url: 'https://example.com/reference' }),
    env,
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return authOk();
      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown: '# Reference\nUseful public content.',
          metadata: { title: 'Reference', sourceURL: 'https://example.com/reference' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.url, 'https://example.com/reference');
  assert.equal(body.title, 'Reference');
  assert.match(body.markdown, /Useful public content/);
  assert.equal(body.truncated, false);
  assert.match(body.notice, /untrusted/i);
  assert.equal(calls[1].url, 'https://api.firecrawl.dev/v2/scrape');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    url: 'https://example.com/reference',
    formats: ['markdown'],
    onlyMainContent: true,
    removeBase64Images: true,
    redactPII: true,
    maxAge: 21600000,
  });
}

{
  let callCount = 0;
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'provider failure' }), env,
    async () => {
      callCount += 1;
      if (callCount === 1) return authOk();
      return new Response(JSON.stringify({
        success: false,
        error: `provider diagnostic must not leak ${firecrawlKey}`,
      }), { status: 500, headers: { 'content-type': 'application/json' } });
    },
  );
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: 'web_research_provider_error' });
  assert.equal(text.includes(firecrawlKey), false);
}

{
  let callCount = 0;
  const huge = 'x'.repeat(129 * 1024);
  const response = await handleGptWebResearchRequest(
    request('/v1/web/search', { query: 'oversized provider result' }), env,
    async () => {
      callCount += 1;
      if (callCount === 1) return authOk();
      return new Response(JSON.stringify({ success: true, data: { web: [{
        title: 'Too large', url: 'https://example.com/', description: huge,
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'web_research_provider_error' });
}

console.log('GPT Web Research tests passed: kill-switched, OAuth/capability gated, provider-isolated, SSRF-filtered, bounded and fail-closed.');
