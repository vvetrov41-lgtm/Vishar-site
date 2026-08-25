#!/usr/bin/env node

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const PROJECT = 'vishar-crm-production';
const SUBDOMAIN = 'vishar-crm-production.pages.dev';
const ACCESS_ORIGIN = 'https://vishar-site-pages.cloudflareaccess.com';
const DOMAINS = Object.freeze(['crm.vishartattoo.com', SUBDOMAIN]);
const PRODUCTION_BINDINGS = Object.freeze([
  'CLOUDFLARE_ACCOUNT_ID:secret_text',
  'CLOUDFLARE_WORKERS_EDIT_TOKEN:secret_text',
  'META_APP_SECRET:secret_text',
  'SUPABASE_PUBLISHABLE_KEY:secret_text',
]);

function sameStrings(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function assertProject(body) {
  const project = body?.result;
  if (body?.success !== true || project?.name !== PROJECT) {
    throw new Error('Production Cloudflare Pages target preflight failed');
  }
  if (project.subdomain !== SUBDOMAIN || project.production_branch !== 'production') {
    throw new Error('Production Cloudflare Pages identity mismatch');
  }
  if (!sameStrings(project.domains ?? [], DOMAINS)) {
    throw new Error('Production Cloudflare Pages domain set mismatch');
  }
  const productionBindings = Object.entries(project.deployment_configs?.production?.env_vars ?? {})
    .map(([name, value]) => `${name}:${value?.type ?? 'unknown'}`);
  if (!sameStrings(productionBindings, PRODUCTION_BINDINGS)) {
    throw new Error('Production Cloudflare Pages binding-name set mismatch');
  }
  const previewBindings = Object.keys(project.deployment_configs?.preview?.env_vars ?? {});
  if (previewBindings.length !== 0) {
    throw new Error('Production Cloudflare Pages preview bindings must stay empty');
  }
  if (project.source != null) {
    throw new Error('Production Cloudflare Pages project must remain Direct Upload');
  }
}

export function assertAccessBoundary(url, response) {
  const expectedHost = new URL(url).hostname;
  if (response?.status !== 302) {
    throw new Error(`Production CRM Access boundary missing for ${expectedHost}`);
  }
  const location = response.headers.get('location');
  let target;
  try {
    target = new URL(location);
  } catch {
    throw new Error(`Production CRM Access redirect invalid for ${expectedHost}`);
  }
  if (target.origin !== ACCESS_ORIGIN
    || target.pathname !== `/cdn-cgi/access/login/${expectedHost}`) {
    throw new Error(`Production CRM Access redirect mismatch for ${expectedHost}`);
  }
}

export async function verifyProductionPages(fetchImpl = fetch, env = process.env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = env.CLOUDFLARE_API_TOKEN || '';
  if (!/^[0-9a-f]{32}$/.test(accountId) || !token) {
    throw new Error('Cloudflare production Pages credentials are unavailable');
  }
  const projectResponse = await fetchImpl(`${API_ROOT}/accounts/${accountId}/pages/projects/${PROJECT}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error',
  });
  if (!projectResponse.ok) throw new Error('Production Cloudflare Pages target read failed');
  assertProject(await projectResponse.json());

  for (const url of ['https://crm.vishartattoo.com/', `https://${SUBDOMAIN}/`]) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    assertAccessBoundary(url, response);
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  verifyProductionPages()
    .then(() => console.log('Production CRM Pages target and Access boundary verified.'))
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
}
