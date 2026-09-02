import assert from 'node:assert/strict';
import {
  assertAccessBoundary,
  assertProject,
  assertPubliclyReachable,
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

// The public custom domain must serve, and only a 200 counts: an Access
// redirect there would mean the split had been undone.
assert.doesNotThrow(() => assertPubliclyReachable(
  'https://crm.vishartattoo.com/',
  new Response('<html>the CRM</html>', { status: 200 }),
));
for (const status of [302, 401, 403, 404, 500]) {
  assert.throws(() => assertPubliclyReachable(
    'https://crm.vishartattoo.com/',
    new Response(null, { status }),
  ));
}

// The two halves together: crm public, pages.dev still gated.
const gatedResponse = (hostname) => new Response(null, {
  status: 302,
  headers: { location: `https://vishar-site-pages.cloudflareaccess.com/cdn-cgi/access/login/${hostname}?nonce=redacted` },
});

const calls = [];
await verifyProductionPages(async (url, init) => {
  calls.push({ url: String(url), init });
  if (String(url).includes('/pages/projects/')) return Response.json(project);
  const hostname = new URL(url).hostname;
  if (hostname === 'crm.vishartattoo.com') return new Response('<html>the CRM</html>', { status: 200 });
  return gatedResponse(hostname);
}, {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'unit-test-token',
});
assert.equal(calls.length, 3);
assert.equal(calls[0].init.method, 'GET');
assert.equal(calls[1].init.redirect, 'manual');
assert.equal(calls[2].init.redirect, 'manual');

// A pages.dev name that stopped being gated is a regression the preflight has
// to refuse, or the whole project drifts open behind the host.
await assert.rejects(verifyProductionPages(async (url) => {
  if (String(url).includes('/pages/projects/')) return Response.json(project);
  return new Response('<html>the CRM</html>', { status: 200 });
}, {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'unit-test-token',
}));

// And a custom domain that went back behind Access is refused too.
await assert.rejects(verifyProductionPages(async (url) => {
  if (String(url).includes('/pages/projects/')) return Response.json(project);
  return gatedResponse(new URL(url).hostname);
}, {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'unit-test-token',
}));

console.log('Production CRM Pages preflight tests passed.');
