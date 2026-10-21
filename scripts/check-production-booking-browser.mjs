import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

// No submissions, uploads, contact data or provider calls. A fresh context is
// used for each artist; every non-read HTTP method is blocked before the wire.
export function assessBookingSurface(snapshot) {
  const missing = [];
  if (snapshot.status !== 200) missing.push('page_http_status');
  if (!snapshot.forms) missing.push('form_missing');
  if (!snapshot.names.includes('name')) missing.push('name_control_missing');
  if (!snapshot.names.includes('email')) missing.push('email_control_missing');
  if (!snapshot.fileInputs.length) missing.push('file_control_missing');
  if (!snapshot.stylesheets) missing.push('stylesheet_missing');
  if (snapshot.pageErrors) missing.push('browser_runtime_error');
  if (snapshot.assetErrors) missing.push('script_or_stylesheet_error');
  return { verdict: missing.length ? 'INCOMPLETE' : 'SURFACE_PASS', missing,
    delivery: 'NOT_TESTED_BY_BROWSER', submit: 'BLOCKED' };
}

if (process.argv.includes('--self-test')) {
  const good = { status: 200, forms: 1, names: ['name', 'email'],
    fileInputs: [{ name: 'designReferences' }], stylesheets: 1,
    pageErrors: 0, assetErrors: 0 };
  assert.equal(assessBookingSurface(good).verdict, 'SURFACE_PASS');
  assert.equal(assessBookingSurface({ ...good, forms: 0 }).verdict, 'INCOMPLETE');
  assert.equal(assessBookingSurface({ ...good, status: 500 }).verdict, 'INCOMPLETE');
  assert.equal(assessBookingSurface({ ...good, fileInputs: [] }).verdict, 'INCOMPLETE');
  assert.equal(assessBookingSurface({ ...good, pageErrors: 1 }).verdict, 'INCOMPLETE');
  assert.equal(assessBookingSurface(good).delivery, 'NOT_TESTED_BY_BROWSER');
  console.log('Booking browser verdict tests passed');
} else {
  const require = createRequire(new URL('../admin/package.json', import.meta.url));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH,
    headless: true });
  const results = [];
  try {
    for (const [artist, url] of [
      ['vladimir', 'https://vishartattoo.com/booking/'],
      ['kristina', 'https://kristinavishar.com/booking/'],
    ]) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 },
        serviceWorkers: 'block' });
      const blockedMethods = [];
      await context.route('**/*', route => {
        const method = route.request().method();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          blockedMethods.push(method);
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
      const page = await context.newPage();
      let pageErrors = 0;
      let assetErrors = 0;
      const assetErrorDetails = [];
      const safeAsset = (request, status) => {
        const parsed = new URL(request.url());
        return { url: parsed.origin + parsed.pathname, type: request.resourceType(), status };
      };
      page.on('pageerror', () => { pageErrors++; });
      page.on('response', response => {
        if (response.status() >= 400 && ['script', 'stylesheet'].includes(response.request().resourceType())) {
          assetErrors++;
          assetErrorDetails.push(safeAsset(response.request(), response.status()));
        }
      });
      page.on('requestfailed', request => {
        if (['script', 'stylesheet'].includes(request.resourceType())) {
          assetErrors++;
          assetErrorDetails.push(safeAsset(request, 'network_failed'));
        }
      });
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        const snapshot = await page.evaluate(() => ({
          forms: document.forms.length,
          names: [...document.querySelectorAll('input,select,textarea')].map(e => e.name).filter(Boolean),
          fileInputs: [...document.querySelectorAll('input[type=file]')].map(e => ({
            name: e.name, accept: e.accept, multiple: e.multiple, required: e.required })),
          stylesheets: document.styleSheets.length,
          renderedText: document.body.innerText.trim().length,
          actions: [...document.forms].map(e => ({ method: e.method,
            action: new URL(e.action).origin + new URL(e.action).pathname })),
        }));
        Object.assign(snapshot, { status: response?.status(), pageErrors, assetErrors });
        const final = new URL(page.url());
        results.push({ artist, url, finalUrl: final.origin + final.pathname,
          ...assessBookingSurface(snapshot), snapshot, assetErrorDetails, blockedMethods,
          unproved: ['step_transitions', 'file_size_validation', 'server_validation',
            'artist_routing', 'crm_storage_telegram_delivery'] });
      } catch {
        results.push({ artist, url, verdict: 'UNKNOWN', reason: 'browser_navigation_failed',
          delivery: 'NOT_TESTED_BY_BROWSER', submit: 'BLOCKED', blockedMethods });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  await mkdir('booking-browser-results', { recursive: true });
  await writeFile('booking-browser-results/results.json', JSON.stringify({
    sha: process.env.GITHUB_SHA ?? null, checkedAt: new Date().toISOString(), results,
  }, null, 2));
  for (const result of results) console.log(JSON.stringify(result));
  if (results.some(r => r.verdict !== 'SURFACE_PASS')) process.exitCode = 1;
}
