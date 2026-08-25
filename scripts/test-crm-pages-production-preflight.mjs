import assert from 'node:assert/strict';
import {
  assertAccessBoundary,
  assertProject,
  verifyProductionPages,
} from './verify-crm-pages-production.mjs';

const project = {
  success: true,
  result: {
    name: 'vishar-crm-production',
    subdomain: 'vishar-crm-production.pages.dev',
    production_branch: 'production',
    domains: ['vishar-crm-production.pages.dev', 'crm.vishartattoo.com'],
    source: null,
    deployment_configs: {
      production: { env_vars: {
        CLOUDFLARE_ACCOUNT_ID: { type: 'secret_text' },
        CLOUDFLARE_WORKERS_EDIT_TOKEN: { type: 'secret_text' },
        META_APP_SECRET: { type: 'secret_text' },
        SUPABASE_PUBLISHABLE_KEY: { type: 'secret_text' },
      } },
      preview: { env_vars: {} },
    },
  },
};

assert.doesNotThrow(() => assertProject(project));
for (const mutate of [
  (value) => { value.result.name = 'vishar-crm-production-lookalike'; },
  (value) => { value.result.production_branch = 'main'; },
  (value) => { value.result.domains.push('unexpected.example'); },
  (value) => { delete value.result.deployment_configs.production.env_vars.META_APP_SECRET; },
  (value) => { value.result.deployment_configs.preview.env_vars.META_APP_SECRET = { type: 'secret_text' }; },
  (value) => { value.result.source = { type: 'github' }; },
]) {
  const copy = structuredClone(project);
  mutate(copy);
  assert.throws(() => assertProject(copy));
}

assert.doesNotThrow(() => assertAccessBoundary(
  'https://crm.vishartattoo.com/',
  new Response(null, {
    status: 302,
    headers: { location: 'https://vishar-site-pages.cloudflareaccess.com/cdn-cgi/access/login/crm.vishartattoo.com?nonce=redacted' },
  }),
));
assert.throws(() => assertAccessBoundary(
  'https://crm.vishartattoo.com/',
  new Response('<html>public</html>', { status: 200 }),
));

const calls = [];
await verifyProductionPages(async (url, init) => {
  calls.push({ url: String(url), init });
  if (String(url).includes('/pages/projects/')) return Response.json(project);
  const hostname = new URL(url).hostname;
  return new Response(null, {
    status: 302,
    headers: { location: `https://vishar-site-pages.cloudflareaccess.com/cdn-cgi/access/login/${hostname}?nonce=redacted` },
  });
}, {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'unit-test-token',
});
assert.equal(calls.length, 3);
assert.equal(calls[0].init.method, 'GET');
assert.equal(calls[1].init.redirect, 'manual');
assert.equal(calls[2].init.redirect, 'manual');

console.log('Production CRM Pages preflight tests passed.');
