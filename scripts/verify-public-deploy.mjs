#!/usr/bin/env node
// Verifies a deployed site against the public deploy boundary
// (scripts/build-public.mjs). Read-only: HTTP GET/HEAD only.
//
//   node scripts/verify-public-deploy.mjs --base https://<preview>.pages.dev
//   node scripts/verify-public-deploy.mjs --base https://vishartattoo.com
//
// Preview deployments of this project sit behind Cloudflare Access. To check
// one from a terminal, export an Access service token (never commit it):
//   CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… node scripts/verify-public-deploy.mjs --base https://<branch>.vishar-site.pages.dev
//
// Checks:
//   1. every allowlisted page and root file returns 200;
//   2. assets: every CSS/JS/font file plus one file per asset directory → 200;
//   3. _headers rules apply (security headers on HTML, caching rules);
//   4. _redirects rules apply (301 with the expected Location);
//   5. every git-tracked file outside the public set returns 404, as do the
//      internal directories themselves and an unknown path.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPublicFiles } from './build-public.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = (args[args.indexOf('--base') + 1] || '').replace(/\/$/, '');
if (!args.includes('--base') || !/^https?:\/\//.test(base)) {
  console.error('Usage: verify-public-deploy.mjs --base <https://host>');
  process.exit(2);
}
const CONCURRENCY = 8;
const accessHeaders = process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
  ? { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET }
  : {};

const failures = [];
const passes = [];
const warnings = [];
const fail = (m) => failures.push(m);

function urlForFile(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file.split('/').map(encodeURIComponent).join('/')}`;
}

async function request(urlPath, method = 'GET') {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(base + urlPath, { method, redirect: 'manual', headers: accessHeaders });
      if (method === 'GET') await response.arrayBuffer();
      return response;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

async function pool(items, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

async function main() {
  const probe = await request('/', 'HEAD');
  const probeLocation = probe && probe.headers.get('location');
  if (probeLocation && probeLocation.includes('cloudflareaccess.com')) {
    console.error(`${base} is behind Cloudflare Access; set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (service token).`);
    process.exit(2);
  }
  const { files: publicFiles, problems } = await collectPublicFiles();
  if (problems.length) throw new Error(`public allowlist is inconsistent: ${problems.join('; ')}`);
  const publicSet = new Set(publicFiles);

  // 1–2. Public pages, root files and representative assets.
  const config = new Set(['_headers', '_redirects']);
  const pages = publicFiles.filter((f) => f.endsWith('.html') && f !== '404.html');
  const rootFiles = publicFiles.filter((f) => !f.includes('/') && !f.endsWith('.html') && !config.has(f));
  const firstPerDir = new Map();
  for (const f of publicFiles.filter((f) => f.startsWith('assets/'))) {
    const dir = path.posix.dirname(f);
    if (!firstPerDir.has(dir)) firstPerDir.set(dir, f);
  }
  const assetSample = new Set([
    ...publicFiles.filter((f) => f.startsWith('assets/') && /\.(css|js|woff2?)$/.test(f)),
    ...firstPerDir.values(),
  ]);
  const mustServe = [...pages, ...rootFiles, ...assetSample];
  let served = 0;
  await pool(mustServe, async (file) => {
    const urlPath = urlForFile(file);
    let response = await request(urlPath, 'HEAD');
    if (response && [301, 302, 307, 308].includes(response.status)) {
      const location = new URL(response.headers.get('location'), base + urlPath);
      response = await request(location.pathname, 'HEAD');
    }
    if (!response || response.status !== 200) fail(`public ${urlPath} → ${response ? response.status : 'no response'} (expected 200)`);
    else served += 1;
  });
  passes.push(`${served}/${mustServe.length} public URLs returned 200 (${pages.length} pages, ${rootFiles.length} root files, ${assetSample.size} assets).`);

  // 3. _headers.
  const home = await request('/');
  const expectHeader = (response, name, test, where) => {
    const value = response.headers.get(name);
    if (!value || !test(value)) fail(`${where}: header ${name} = ${JSON.stringify(value)}`);
  };
  expectHeader(home, 'content-security-policy', (v) => v.includes("default-src 'self'"), '/');
  expectHeader(home, 'x-frame-options', (v) => v.toUpperCase() === 'DENY', '/');
  expectHeader(home, 'strict-transport-security', (v) => v.includes('max-age=31536000'), '/');
  expectHeader(home, 'x-content-type-options', (v) => v === 'nosniff', '/');
  const vendor = publicFiles.find((f) => f.startsWith('assets/vendor/'));
  if (vendor) expectHeader(await request(urlForFile(vendor), 'HEAD'), 'cache-control', (v) => v.includes('immutable'), `/${vendor}`);
  // Zone-level Cloudflare cache settings can override this rule (observed on
  // production before the boundary change: max-age=14400), so it is a warning.
  const componentsCache = (await request('/components.js', 'HEAD')).headers.get('cache-control') || '';
  if (!componentsCache.includes('no-cache')) warnings.push(`/components.js cache-control = ${JSON.stringify(componentsCache)} (_headers asks for no-cache; zone cache settings may override)`);
  passes.push('_headers security headers on / and immutable caching on a vendor asset.');

  // 4. _redirects.
  const redirectRules = (await fs.readFile(path.join(rootDir, '_redirects'), 'utf8'))
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
  for (const [from, to, status] of redirectRules) {
    const response = await request(from, 'HEAD');
    const location = response.headers.get('location') || '';
    if (String(response.status) !== String(status || 301) || !location.endsWith(to)) {
      fail(`redirect ${from} → ${response.status} ${location} (expected ${status || 301} ${to})`);
    }
  }
  passes.push(`${redirectRules.length} _redirects rules checked.`);

  // 5. Everything tracked but not public must be 404.
  const tracked = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' }).split('\n').filter(Boolean);
  const privateFiles = tracked.filter((f) => !publicSet.has(f) || config.has(f));
  const privateDirs = [...new Set(privateFiles.map((f) => f.split('/')[0]).filter((d) => tracked.some((f) => f.startsWith(`${d}/`))))]
    .filter((d) => !publicFiles.some((f) => f.startsWith(`${d}/`)))
    .map((d) => `${d}/`);
  const extra = ['prototypes/', 'specs/', 'source-assets/', 'dist/', 'definitely-not-a-page-7f3a/'];
  const mustHide = [...privateFiles.map(urlForFile), ...[...privateDirs, ...extra].map((d) => `/${d}`)];
  let hidden = 0;
  // _headers and _redirects are reserved by Pages and never served (404 on
  // Pages; `wrangler pages dev` answers 502), so any error status passes.
  const reserved = new Set(['/_headers', '/_redirects']);
  await pool([...new Set(mustHide)], async (urlPath) => {
    const response = await request(urlPath, 'HEAD');
    const ok = response && (reserved.has(urlPath) ? response.status >= 400 : response.status === 404);
    if (!ok) fail(`private ${urlPath} → ${response ? response.status : 'no response'} (expected 404)`);
    else hidden += 1;
  });
  passes.push(`${hidden}/${new Set(mustHide).size} private paths returned 404 (every tracked file outside the allowlist, internal directories, unknown path).`);

  for (const p of passes) console.log(`PASS ${p}`);
  for (const w of warnings) console.log(`WARN ${w}`);
  for (const f of failures.slice(0, 80)) console.log(`FAIL ${f}`);
  if (failures.length > 80) console.log(`… ${failures.length - 80} more failures`);
  console.log(`${base}: ${failures.length ? `${failures.length} failures` : 'deploy boundary verified'}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
