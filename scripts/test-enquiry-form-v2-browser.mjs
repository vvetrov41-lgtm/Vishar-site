#!/usr/bin/env node
// Browser checks for the booking form v2 (assets/js/enquiry-form-v2.js).
//
//   node scripts/test-enquiry-form-v2-browser.mjs [--crm ../crm] [--only name]
//
// Serves the repository root, opens /booking/?enquiry_form=v2 in Chromium at
// iPhone and desktop sizes, and answers the intake endpoint either with the
// real CRM Worker (--crm points at a checkout of the CRM trunk; Supabase and
// Storage are stubbed and every RPC argument is recorded) or with a small
// contract mock. Nothing is sent to any real service.
//
// Requires Playwright (PLAYWRIGHT_MODULE may point at its index.mjs) and, for
// accessibility checks, axe-core (AXE_PATH may point at axe.min.js).

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const crmDir = argValue('--crm') ? path.resolve(argValue('--crm')) : '';
const only = argValue('--only');
const fixturesDir = argValue('--fixtures') || process.env.ENQUIRY_FIXTURES || '';

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
// axe is required: a missing bundle must fail setup, not skip the WCAG checks.
const axeSource = await readFile(process.env.AXE_PATH || path.join(rootDir, 'node_modules/axe-core/axe.min.js'), 'utf8');


// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

const TYPES = { '.glb':'model/gltf-binary', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json' };
// HTTPS, because the Meta handoff is only produced on https:// pages.
const certDir = mkdtempSync(path.join(os.tmpdir(), 'enquiry-v2-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
const tls = { key: await readFile(path.join(certDir, 'key.pem')), cert: await readFile(path.join(certDir, 'cert.pem')) };
const server = createHttpsServer(tls, async (req, res) => {
  try {
    let file = path.join(rootDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(rootDir)) throw new Error('outside');
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    let body = await readFile(file);
    if (file.endsWith(path.join('booking', 'index.html'))) {
      body = Buffer.from(String(body).replace('<meta name="vishar-booking-endpoint" content="">', `<meta name="vishar-booking-endpoint" content="${ENDPOINT}">`));
    }
    const extra = process.env.TEST_CALCULATOR_3D==='1' && file.endsWith(path.join('tattoo-price-calculator','index.html')) ? {'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'"} : {};
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `https://127.0.0.1:${server.address().port}`;

// The intake endpoint is a real local HTTP server so the browser sends real
// multipart bytes (request interception does not reliably expose file parts).
let active = null; // { log, intercept } for the scenario in progress
const intakeServer = createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = `http://${req.headers.host}${req.url}`;
  const contentType = req.headers['content-type'] || '';
  const parsed = await new Request('http://x', { method: 'POST', headers: { 'Content-Type': contentType }, body }).formData();
  const entry = { url, fields: {}, files: {} };
  for (const [key, value] of parsed.entries()) {
    if (typeof value === 'string') entry.fields[key] = value;
    else (entry.files[key] ||= []).push({ name: value.name, type: value.type, size: value.size });
  }
  const { log, intercept } = active;
  log.requests.push(entry);
  if (process.env.DEBUG_INTAKE) console.log('REQUEST', JSON.stringify(entry.files));
  const respond = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors }); res.end(typeof json === 'string' ? json : JSON.stringify(json)); };
  const control = { abort: () => req.socket.destroy(), fulfill: respond };
  if (intercept && await intercept(control, entry, log)) return;
  const result = await backend.handle({ url, contentType, body }, log);
  respond(result.status, result.body);
});
await new Promise((resolve) => intakeServer.listen(0, '127.0.0.1', resolve));
const ENDPOINT = `http://127.0.0.1:${intakeServer.address().port}/`;

// ---------------------------------------------------------------------------
// Intake backends
// ---------------------------------------------------------------------------

let backend;
if (crmDir) {
  const worker = (await import(pathToFileURL(path.join(crmDir, 'workers/tattooai.js')).href)).default;
  const env = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    BOOKING_SOURCE_KEY: 'vladimir-website',
    BOOKING_FORM_VERSION: 'booking-v1',
    TELEGRAM_BOT_TOKEN: 'legacy-test-token',
    TELEGRAM_CHAT_ID: 'legacy-test-chat',
  };
  const realFetch = globalThis.fetch;
  backend = {
    name: 'real CRM Worker',
    async handle(request, log) {
      const ids = Array.from({ length: 6 }, (_, n) => `f${String(n).repeat(7)}-0000-4000-8000-00000000000${n}`);
      globalThis.fetch = async (url, init = {}) => {
        const href = String(url);
        if (href.includes('/rest/v1/rpc/')) {
          const name = href.split('/rest/v1/rpc/')[1];
          const body = init.body ? JSON.parse(init.body) : {};
          log.rpc.push({ name, args: body });
          if (name === 'create_trusted_enquiry_intake') {
            const replayed = log.keys.has(body.p_idempotency_key);
            log.keys.add(body.p_idempotency_key);
            return Response.json({
              enquiry_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', client_id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              reference_number: 'ENQ-2026-0420', intake_state: replayed ? 'complete' : 'files_pending', replayed,
              client_conflict: false,
              files: body.p_files.map((file, index) => ({
                file_id: ids[index], ordinal: index,
                storage_path: `clients/cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee/enquiries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/references/${ids[index]}.${file.safe_extension}`,
                upload_state: replayed ? 'ready' : 'pending', mime_type: file.mime_type, safe_extension: file.safe_extension,
                byte_size: file.byte_size, checksum: file.checksum,
              })),
            });
          }
          if (name === 'finalize_enquiry_intake') return Response.json({ intake_state: 'complete', outbox_id: null });
          return Response.json({ ok: true });
        }
        if (href.includes('/storage/v1/object/')) { log.uploads += 1; return new Response('{}', { status: 200 }); }
        if (href.includes('api.telegram.org')) return new Response('{}', { status: 200 });
        if (href.includes('api.cloudflare.com') || href.includes('gateway.ai')) return new Response('{}', { status: 500 });
        return realFetch(url, init);
      };
      try {
        const forwarded = new Request(request.url, { method: 'POST', headers: { 'Content-Type': request.contentType, Origin: 'https://vishartattoo.com' }, body: request.body });
        const response = await worker.fetch(forwarded, env, { waitUntil() {} });
        return { status: response.status, body: await response.text() };
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  };
} else {
  backend = {
    name: 'contract mock',
    async handle(request, log) {
      const form = await new Request('http://x', { method: 'POST', headers: { 'Content-Type': request.contentType }, body: request.body }).formData();
      if (form.get('preflight') === '1') return { status: 200, body: JSON.stringify({ ok: true, preflight: { id: '', status: 'ok', messages: [] } }) };
      log.keys.add(form.get('idempotencyKey'));
      return { status: 200, body: JSON.stringify({ ok: true, reference: 'ENQ-2026-0420' }) };
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];
let browser;

function fixture(name) {
  if (!fixturesDir) throw new Error('Pass --fixtures <dir> with design.jpg, existing.png, existing2.webp, iphone-large.jpg, not-image.jpg');
  return path.join(fixturesDir, name);
}

async function openPage({ device = 'iPhone 13', query = '', init = null, intercept = null } = {}) {
  const context = await browser.newContext({ ...(device === 'desktop' ? { viewport: { width: 1280, height: 900 } } : devices[device]), ignoreHTTPSErrors: true });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const log = { requests: [], forms: [], rpc: [], uploads: 0, keys: new Set(), errors: [] };
  page.on('pageerror', (error) => log.errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) log.errors.push(message.text()); });
  await page.route('https://connect.facebook.net/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route('https://bzrcdn.openai.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route('https://www.googletagmanager.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  active = { log, intercept };
  await page.goto(`${BASE}/booking/?enquiry_form=v2${query}`);
  await page.waitForSelector('.ef-choice');
  return { page, context, log };
}

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${name}\n     ${error.stack.split('\n').slice(0, 4).join('\n     ')}`);
  }
}

// --- Page actions ---------------------------------------------------------

const pick = (page, label, scope = page.locator('#enquiry-v2')) => scope.locator('label.ef-choice', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }).first().click();
const group = (page, legend) => page.locator('#enquiry-v2 fieldset', { has: page.locator('legend', { hasText: legend }) });
const next = (page) => page.locator('#enquiry-v2 .ef-btn-primary').click();
const section = (page) => page.locator('#ef-section').textContent();
const errorText = (page) => page.locator('#ef-error').textContent();

async function expectSection(page, title) {
  await page.waitForFunction((t) => document.getElementById('ef-section')?.textContent === t, title, { timeout: 5000 });
}

async function noHorizontalScroll(page, where) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width, `${where}: horizontal scroll ${scroll} > ${width}`);
}

async function upload(page, role, files) {
  await page.locator(`#enquiry-v2 [data-image-role="${role}"] input[type=file]`).setInputFiles(files);
  await page.waitForFunction(({ role, n }) => document.querySelectorAll(`#enquiry-v2 [data-image-role="${role}"] .ef-thumb`).length >= n, { role, n: files.length }, { timeout: 15000 });
}

async function contactEmail(page, { name = 'Vera Client', email = 'vera@example.test', phone = '' } = {}) {
  await page.locator('#enquiry-v2').getByLabel('When would you like to start?').fill('Spring 2027');
  await page.locator('#enquiry-v2').getByLabel(/^Full name/).fill(name);
  await pick(page, 'Email');
  await page.locator('#enquiry-v2').getByRole('textbox', { name: /^Email/ }).fill(email);
  if (phone) await page.locator('#enquiry-v2').getByLabel(/^WhatsApp \(backup\)/).fill(phone);
}

/** Runs a project from screen 1 to review. `areas` = [{ region, placements, work }]. */
async function fillProject(page, { areas, styles = ['Black & Grey realism'], idea = 'A realistic owl in soft light.', design = [], existing = [], discovery = 'Instagram', contact = {} }) {
  for (const area of areas) await pick(page, area.region, group(page, 'Where would you like your tattoo?'));
  await next(page);
  if (areas.some((a) => a.region !== 'Other')) {
    await expectSection(page, 'Details');
    for (const area of areas) {
      if (area.region === 'Other') continue;
      const scope = areas.filter((a) => a.region !== 'Other').length > 1 ? group(page, area.region) : page.locator('#enquiry-v2');
      for (const placement of area.placements) await pick(page, placement, scope);
    }
    await next(page);
  }
  await expectSection(page, 'Existing work');
  for (const area of areas) {
    const scope = areas.length > 1 ? group(page, area.region) : page.locator('#enquiry-v2');
    for (const work of area.work) await pick(page, work, scope);
  }
  await next(page);
  await expectSection(page, 'Design');
  for (const style of styles) await pick(page, style);
  await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill(idea);
  await page.locator('#enquiry-v2').getByLabel(/^Exact placement and approximate size/).fill('About 20 cm');
  if (await page.locator('#enquiry-v2').getByLabel(/^Existing tattoo details/).count()) await page.locator('#enquiry-v2').getByLabel(/^Existing tattoo details/).fill('Faded, about 8 years old');
  await next(page);
  await expectSection(page, 'Images');
  if (existing.length) await upload(page, 'existing', existing);
  if (design.length) await upload(page, 'design', design);
  await next(page);
  await expectSection(page, 'Discovery');
  await pick(page, discovery);
  await next(page);
  await expectSection(page, 'Contact');
  if (contact.whatsapp) {
    await page.locator('#enquiry-v2').getByLabel(/^Full name/).fill(contact.name || 'Walt App');
    await pick(page, 'WhatsApp');
    await page.locator('#enquiry-v2').getByLabel(/^WhatsApp number/).fill(contact.whatsapp);
    if (contact.email) await page.locator('#enquiry-v2').getByLabel(/^Email \(backup\)/).fill(contact.email);
  } else {
    await contactEmail(page, contact);
  }
  await next(page);
  await expectSection(page, 'Review');
}

async function send(page) {
  await page.locator('.ef-consent').click();
  await next(page);
  await page.waitForSelector('#enquiry-success:not(.hidden)', { timeout: 20000 });
}

function finalSubmission(log) {
  return log.requests.filter((r) => r.fields.preflight !== '1').at(-1);
}
function intake(log) {
  return log.rpc.filter((r) => r.name === 'create_trusted_enquiry_intake').at(-1)?.args;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

browser = await chromium.launch({...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{}),args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
console.log(`Intake backend: ${backend.name}`);

await test('Calculator mobile layout, accessibility and intake', async () => {
  const {page,context,log} = await openPage();
  await page.goto(BASE + '/tattoo-price-calculator/');
  await page.getByRole('button', {name:'Decline', exact:true}).click();
  if(process.env.TEST_CALCULATOR_3D==='1'){
    await page.locator('.calc-webgl[data-ready="true"]').waitFor({timeout:30000});
    await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await page.getByRole('button',{name:'Front',exact:true}).click();
    await page.getByRole('button',{name:'Forearm',exact:true}).click();
    const model=page.locator('.calc-webgl');
    const fraction=async()=>Number(await model.getAttribute('data-selected-vertices'))/Number(await model.getAttribute('data-vertex-count'));
    const large=await fraction();assert.ok(large>0);
    const lowerRegions=JSON.parse(await model.getAttribute('data-highlighted-regions'));
    assert.ok(lowerRegions['elbow|left']>0&&lowerRegions['forearm|left']>0&&lowerRegions['wrist|left']>0,'forearm spans elbow to wrist');
    assert.equal(lowerRegions['upper_arm|left'],undefined);
    await page.getByRole('button',{name:'Wraparound',exact:true}).click();
    const wrap=await fraction();assert.ok(large/wrap>.32&&large/wrap<.72,'forearm panel should approximate half of wraparound coverage');
    await page.getByRole('button',{name:'One side',exact:true}).click();
    const beforeRotate=await fraction();
    await page.getByRole('button',{name:'Back',exact:true}).click();
    assert.ok(Math.abs((await fraction())-beforeRotate)<.006,'rotation must preserve the selected surface');
    await page.getByRole('button',{name:'Front',exact:true}).click();
    await page.getByRole('button',{name:'Upper arm',exact:true}).click();
    const upperPanel=await fraction();
    const upperRegions=JSON.parse(await model.getAttribute('data-highlighted-regions'));
    assert.ok(upperRegions['shoulder|left']>0&&upperRegions['upper_arm|left']>0&&upperRegions['elbow|left']>0,'upper arm spans shoulder to elbow');
    assert.equal(upperRegions['forearm|left'],undefined);
    assert.ok(Number(await model.getAttribute('data-shoulder-trimmed'))>0,'upper arm excludes medial shoulder/trapezius spill');
    await page.getByRole('button',{name:'Wraparound',exact:true}).click();
    assert.ok(upperPanel/(await fraction())>.32&&upperPanel/(await fraction())<.8,'upper-arm panel should cover approximately half of the arm');
    await page.getByRole('button',{name:'Forearm',exact:true}).click();
    await page.getByRole('button',{name:'Focus area',exact:true}).click();
    assert.equal(await model.getAttribute('data-focused-area'),'arm');
    await page.getByRole('button',{name:'Front',exact:true}).click();
    assert.equal(await model.getAttribute('data-focused-area'),null);
    await page.getByRole('button',{name:'Small piece',exact:true}).click();
    const small=await fraction();assert.ok(small>0&&small<large,'small piece should highlight less skin');
    assert.equal(await page.locator('.calc-result').innerText(),'£420–£560');
    await page.getByRole('button',{name:'Full sleeve',exact:true}).click();
    assert.match(await page.locator('.calc-result').innerText(),/£5,880–£7,840/);
    const full=await fraction();
    await page.locator('#calc-arm-length').fill('2');
    const partial=await fraction();assert.ok(partial>0&&partial<full,'3/4 sleeve must highlight less skin than full sleeve');
    await page.getByRole('button',{name:'Half sleeve',exact:true}).click();
    await page.getByRole('button',{name:'Outer side · full length',exact:true}).click();
    const outerArm=JSON.parse(await model.getAttribute('data-highlighted-regions'));
    assert.ok(outerArm['shoulder|left']>0&&outerArm['forearm|left']>0&&outerArm['wrist|left']>0);
    assert.match(await page.locator('.calc-result').innerText(),/£2,940–£4,900/);
    await page.getByRole('button',{name:'Inner side · full length',exact:true}).click();
    assert.ok(await fraction()>0);
    await page.getByRole('button',{name:'Half leg sleeve',exact:true}).click();
    await page.getByRole('button',{name:'Outer side · full length',exact:true}).click();
    const outerLeg=JSON.parse(await model.getAttribute('data-highlighted-regions'));
    assert.ok(outerLeg['thigh|left']>0&&outerLeg['calf|left']>0&&outerLeg['ankle|left']>0);
    await page.getByRole('button',{name:'Inner side · full length',exact:true}).click();
    assert.ok(await fraction()>0);
    await page.getByRole('button',{name:'Reset calculator',exact:true}).click();
    await page.getByText('Choose another body area',{exact:true}).click();
    const placements=await page.locator('#calc-placement-list option').evaluateAll(os=>os.map(o=>o.value).filter(Boolean));
    const audit=[];
    for(const placement of placements){
      await page.locator('#calc-placement-list').selectOption(placement);
      const n=Number(await model.getAttribute('data-selected-vertices'));
      const regions=JSON.parse(await model.getAttribute('data-highlighted-regions')||'{}');
      const price=await page.locator('.calc-result').innerText();
      audit.push({placement,vertices:n,regions:Object.keys(regions),price});
    }
    console.log('ALL ZONE AUDIT '+JSON.stringify(audit));
    assert.ok(audit.every(x=>x.vertices>0&&x.price.includes('£')),JSON.stringify(audit.filter(x=>!x.vertices||!x.price.includes('£'))));
    for(const key of ['chest_ribs|ribs','chest_ribs|collarbone','back|shoulder_blade','stomach_sides|side','stomach_sides|hip','neck_head|side_neck','neck_head|behind_ear']){const item=audit.find(x=>x.placement===key);assert.ok(item.regions.every(x=>!x.endsWith('|right')),key+' must highlight one side');}
    assert.ok(audit.find(x=>x.placement==='back|lower_back').regions.includes('spine|centre'),'lower back includes the lower spine');
    await page.getByRole('button',{name:'Reset calculator',exact:true}).click();
  }
  await page.getByRole('button',{name:'2D',exact:true}).click();
  for (const width of [320,390,1024]) {
    await page.setViewportSize({width,height:844});
    await noHorizontalScroll(page,'calculator');
    assert.ok(await page.locator('.calc-toolbar').isVisible());
    assert.ok(await page.locator('.calc-toolbar').evaluate(e=>e.getBoundingClientRect().height)<90,'single-row model toolbar');
    const overlap=await page.evaluate(()=>{const a=document.querySelector('.calc-output').getBoundingClientRect(),b=document.querySelector('.calc-mode').getBoundingClientRect();return a.bottom>b.top+1;});
    assert.equal(overlap,false,'price block must not overlap controls');
    assert.equal(await page.locator('.calc-output .calc-stat').count(),2);
    assert.equal(await page.locator('.calc-output .calc-help').count(),1);
    assert.match(await page.locator('.calc-output .calc-help').innerText(),/Tap the body or choose a quick project/);
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.scrollTo(0,document.querySelector('.calc-atlas').getBoundingClientRect().top+window.scrollY+100));
  await page.waitForFunction(()=>{const p=document.querySelector('.calc-output').getBoundingClientRect(),h=document.querySelector('#site-nav nav').getBoundingClientRect();return Math.abs(p.top-h.bottom)<3&&p.height<260&&document.querySelector('.calc-output .calc-stat-row')!==null;});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.addScriptTag({content:axeSource});
  const audit = await page.evaluate(() => axe.run('main', {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  assert.deepEqual(audit.violations.map(v => v.id),[], JSON.stringify(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))));
  const bytes = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(r => /tattoo-(pricing|calculator)\.(js|css)/.test(r.name))
    .reduce((sum,r) => sum + r.decodedBodySize,0));
  assert.ok(bytes > 0 && bytes < 75000);
  assert.equal(await page.locator('#calc-next').isVisible(),false,'no booking prompt before choosing a project');
  await page.getByText('Choose another body area',{exact:true}).click();
  await page.getByLabel('Body area',{exact:true}).selectOption('leg|calf');
  assert.match(await page.locator('.calc-selection').innerText(),/Calf/);
  assert.equal(await page.locator('.calc-result').innerText(),'£980–£2,940');
  await page.getByRole('button',{name:'Reset calculator',exact:true}).click();
  await page.getByRole('button',{name:'Add another area',exact:true}).click();
  await page.getByRole('button',{name:'Forearm',exact:true}).click();
  await page.getByRole('button',{name:'Full back',exact:true}).click();
  assert.equal(await page.locator('.calc-area-row').count(),2);
  assert.equal(await page.locator('.calc-result').innerText(),'By assessment');
  assert.equal(await page.locator('.calc-breakdown-row').count(),2);
  assert.match(await page.locator('.calc-breakdown').innerText(),/£980–£1,960/);
  await page.getByRole('button',{name:/Remove Full back/}).click();
  await page.getByRole('button',{name:'Full leg',exact:true}).click();
  assert.equal(await page.locator('.calc-result').innerText(),'£8,820–£11,760+');
  assert.match(await page.locator('#calc-estimate').innerText(),/tattooed independently/);
  await page.getByRole('button',{name:'Reset calculator',exact:true}).click();
  await page.getByRole('button',{name:'Forearm',exact:true}).click();
  await page.getByRole('button',{name:'Small piece',exact:true}).click();
  assert.ok(await page.locator('.calc-figure .hit.on.small').count()>0);
  assert.equal(await page.locator('.calc-result').innerText(),'£420–£560');
  await page.getByRole('button',{name:'Full area',exact:true}).click();
  assert.equal(await page.locator('.calc-figure .hit.on.small').count(),0);
  await page.getByRole('button',{name:'Wraparound',exact:true}).click();
  await page.getByRole('button',{name:'Estimate a lower half sleeve instead (elbow to wrist)',exact:true}).click();
  assert.equal(await page.locator('.calc-result').innerText(),'£2,940–£3,920');
  await page.getByRole('button',{name:'Colour',exact:true}).click();
  assert.equal(await page.locator('.calc-result').innerText(),'£3,920–£4,900');
  await page.getByRole('button',{name:'Black & Grey',exact:true}).click();
  await page.getByRole('button',{name:'Full sleeve',exact:true}).click();
  await page.getByRole('button',{name:'Front',exact:true}).click();
  await page.getByRole('button',{name:'Left',exact:true}).click();
  assert.ok(await page.locator('.calc-figure .hit.on[data-side="left"]').count()>0);
  assert.equal(await page.locator('.calc-figure .hit.on[data-side="right"]').count(),0);
  await page.getByRole('button',{name:'Colour',exact:true}).click();
  assert.match(await page.locator('.calc-result').innerText(),/£7,840–£9,800/);
  await page.getByRole('button',{name:'Black & Grey',exact:true}).click();
  assert.match(await page.locator('.calc-result').innerText(),/£5,880–£7,840/);
  assert.equal(await page.locator('.calc-output .calc-help').innerText(),'Final cost may vary depending on design complexity, size and placement.');
  await page.getByRole('button',{name:/Existing tattoo \/ cover-up/}).click();
  assert.match(await page.locator('.calc-result').innerText(),/£7,840–£9,800/);
  assert.match(await page.locator('.calc-output').innerText(),/touch-up may be needed after full healing/);
  assert.equal(await page.getByRole('button',{name:'Black & Grey',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:/Cover-up · photos needed/}).click();
  assert.match(await page.locator('.calc-result').innerText(),/£5,880–£7,840/);
  await page.getByRole('button',{name:'By budget',exact:true}).click();
  await page.getByLabel('Your budget (£)',{exact:true}).fill('2000');
  assert.equal(await page.locator('.calc-result').innerText(),'£2,000');
  assert.match(await page.locator('.calc-stat-row').innerText(),/14.25 h/);
  assert.equal(await page.locator('#calc-next').isVisible(),false);
  await page.getByRole('button',{name:'By time',exact:true}).click();
  await page.getByRole('button',{name:'2 days',exact:true}).click();
  assert.equal(await page.locator('.calc-result').innerText(),'£1,960');
  assert.equal(await page.locator('#calc-next').isVisible(),false,'time calculation does not offer an enquiry');
  await page.getByRole('button',{name:'By tattoo',exact:true}).click();
  await page.locator('#calc-arm-length').fill('2');
  assert.match(await page.locator('.calc-result').innerText(),/£3,920–£6,860/);
  await page.locator('#calc-arm-length').fill('3');
  await page.getByRole('button',{name:'Colour',exact:true}).click();
  await page.getByRole('button',{name:'Use this selection in an enquiry (optional)',exact:true}).click();
  await expectSection(page,'Design');
  await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill('Colour wildlife sleeve');
  await next(page); await upload(page,'design',[fixture('design.jpg')]);
  await next(page); await pick(page,'Instagram'); await next(page);
  await contactEmail(page,{}); await next(page); await send(page);
  const submission=finalSubmission(log).fields;
  const details=JSON.parse(submission.projectDetails);
  assert.deepEqual(details.areas,[{region:'arm',placements:['full_sleeve'],work:['new']}]);
  assert.deepEqual(details.styles,['colour']);
  assert.doesNotMatch(details.sizeNotes,/£/);
  assert.match(submission.idea,/£7,840–£9,800/);
  assert.match(submission.idea,/Placement and coverage: Full sleeve/);
  console.log('Calculator assets, decoded bytes:',bytes);
  await context.close();
});

await test('Calculator mobile optional booking dialog and live transfer', async () => {
 const {page,context}=await openPage();
 await page.goto(BASE+'/booking/');
 await page.getByRole('button',{name:'Decline',exact:true}).click();
 await expectSection(page,'Placement');
 await page.getByRole('link',{name:'Open calculator',exact:true}).click();
 const dialog=page.locator('#booking-calculator-dialog');
 assert.equal(await dialog.isVisible(),true);
 await dialog.evaluate(el=>el.scrollTop=250);
 await page.waitForFunction(()=>{const d=document.querySelector('#booking-calculator-dialog'),p=d.querySelector('.calc-output').getBoundingClientRect(),h=d.querySelector('.booking-calculator-header').getBoundingClientRect();return Math.abs(p.top-h.bottom)<3&&p.height<260&&d.querySelector('.calc-output .calc-stat-row')!==null;});
 await dialog.evaluate(el=>el.scrollTop=0);
 if(process.env.TEST_CALCULATOR_3D==='1')await dialog.locator('.calc-webgl[data-ready="true"]').waitFor({timeout:30000});
 await dialog.getByRole('button',{name:'Full sleeve',exact:true}).click();
 await dialog.getByRole('button',{name:'Right',exact:true}).click();
 await dialog.getByRole('button',{name:'Black & Grey',exact:true}).click();
 assert.match(await dialog.locator('.calc-result').innerText(),/£5,880–£7,840/);
 await page.getByRole('button',{name:'Close calculator',exact:true}).click();
 await expectSection(page,'Placement');
 await page.getByRole('link',{name:'Open calculator',exact:true}).click();
 await dialog.getByRole('button',{name:'Apply selection to enquiry (optional)',exact:true}).click();
 await expectSection(page,'Design');
 assert.equal(await dialog.isVisible(),false);
 assert.match(await page.locator('#enquiry-v2').getByLabel(/^Exact placement and approximate size/).inputValue(),/Right/);
 await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill('Keep this idea');
 assert.match(await page.locator('.ef-calculator-price').innerText(),/£5,880–£7,840/);
 await page.getByRole('link',{name:'Edit selection',exact:true}).click();
 await dialog.getByRole('button',{name:'Colour',exact:true}).click();
 await page.getByRole('button',{name:'Close calculator',exact:true}).click();
 assert.equal(await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).inputValue(),'Keep this idea');
 assert.match(await page.locator('.ef-calculator-price').innerText(),/£5,880–£7,840/);
 await page.getByRole('link',{name:'Edit selection',exact:true}).click();
 assert.match(await dialog.locator('.calc-result').innerText(),/£5,880–£7,840/);
 await dialog.getByRole('button',{name:'Colour',exact:true}).click();
 await dialog.getByRole('button',{name:'Apply selection to enquiry (optional)',exact:true}).click();
 assert.match(await page.locator('.ef-calculator-price').innerText(),/£7,840–£9,800/);
 assert.equal(await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).inputValue(),'Keep this idea');
 await context.close();
});

await test('1 new tattoo with one design reference (iPhone)', async () => {
  const { page, context, log } = await openPage();
  await fillProject(page, { areas: [{ region: 'Arm', placements: ['Forearm'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  await noHorizontalScroll(page, 'review');
  await send(page);
  const submission = finalSubmission(log);
  assert.equal(submission.fields.formSchema, 'enquiry-v2');
  assert.deepEqual(JSON.parse(submission.fields.projectDetails).areas, [{ region: 'arm', placements: ['forearm'], work: ['new'] }]);
  assert.equal(submission.files.designReferences.length, 1);
  assert.equal(submission.files.existingTattooPhotos, undefined);
  assert.match(await page.locator('#enquiry-success-message').textContent(), /ENQ-2026-0420/);
  // Leaving or reloading after success must not recreate the draft.
  await page.reload();
  await page.waitForSelector('.ef-choice');
  assert.equal(await page.evaluate(() => localStorage.getItem('vishar.enquiry.v2.draft')), null, 'no draft after success and pagehide');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('vishar.enquiry.v2.contact')), null, 'no contact copy after success and pagehide');
  assert.equal(await page.locator('.ef-notice:not([hidden])').count(), 0, 'nothing restored');
  if (crmDir) {
    const args = intake(log);
    assert.equal(args.p_enquiry.placement, 'Arm: Forearm');
    assert.deepEqual(args.p_files.map((f) => f.intake_role), ['design_reference']);
    assert.equal(log.uploads, 1);
  }
  assert.deepEqual(log.errors, []);
  await context.close();
});

await test('2 plain cover-up with one existing photo', async () => {
  const { page, context, log } = await openPage();
  await fillProject(page, { areas: [{ region: 'Back', placements: ['Shoulder blade'], work: ['Cover-up'] }], existing: [fixture('existing.png')] });
  assert.equal(await page.locator('.ef-summary').getByText('1 existing tattoo').count(), 1);
  await send(page);
  const submission = finalSubmission(log);
  assert.equal(submission.files.existingTattooPhotos.length, 1);
  if (crmDir) {
    const args = intake(log);
    assert.equal(args.p_enquiry.project_type, 'Cover-up');
    assert.equal(args.p_enquiry.project_details.existingDetails, 'Faded, about 8 years old');
  }
  await context.close();
});

await test('3 full sleeve + forearm cover-up requires both categories', async () => {
  const { page, context, log } = await openPage();
  await pick(page, 'Arm'); await next(page);
  await pick(page, 'Full sleeve'); await pick(page, 'Forearm');
  assert.ok(await page.locator('.ef-note:not([hidden])').count(), 'sleeve note shown');
  await pick(page, 'Half sleeve');
  assert.equal(await page.locator('input[value="full_sleeve"]').isChecked(), false, 'sleeve lengths are exclusive');
  await pick(page, 'Full sleeve');
  await next(page);
  await pick(page, 'Cover-up'); await next(page);
  await pick(page, 'Black & Grey realism');
  await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill('Sleeve covering an old forearm piece.');
  await next(page);
  await expectSection(page, 'Images');
  assert.equal(await page.locator('[data-image-role="design"] .required').count(), 1, 'design marked required');
  assert.equal(await page.locator('[data-image-role="existing"] .required').count(), 1, 'existing marked required');
  await upload(page, 'existing', [fixture('existing.png')]);
  await next(page);
  assert.match(await errorText(page), /design reference/);
  await upload(page, 'design', [fixture('design.jpg')]);
  await next(page);
  await expectSection(page, 'Discovery');
  await pick(page, 'Google'); await next(page);
  await contactEmail(page); await next(page);
  await send(page);
  const details = JSON.parse(finalSubmission(log).fields.projectDetails);
  assert.deepEqual(details.areas[0].placements.sort(), ['forearm', 'full_sleeve']);
  if (crmDir) assert.deepEqual(intake(log).p_files.map((f) => f.intake_role), ['design_reference', 'existing_tattoo']);
  await context.close();
});

await test('4 full sleeve + rework + extension', async () => {
  const { page, context, log } = await openPage();
  await fillProject(page, { areas: [{ region: 'Arm', placements: ['Full sleeve'], work: ['Rework', 'Extend existing tattoo'] }], design: [fixture('design.jpg')], existing: [fixture('existing.png'), fixture('existing2.webp')] });
  await send(page);
  const details = JSON.parse(finalSubmission(log).fields.projectDetails);
  assert.deepEqual(details.areas[0].work, ['rework', 'extension']);
  if (crmDir) assert.deepEqual(intake(log).p_enquiry.project_details.areas[0].work, ['Rework', 'Extension']);
  await context.close();
});

await test('5 arm + leg with different work types, 6 B&G + colour (desktop)', async () => {
  const { page, context, log } = await openPage({ device: 'desktop' });
  await fillProject(page, {
    areas: [{ region: 'Arm', placements: ['Upper arm'], work: ['No existing tattoo'] }, { region: 'Leg', placements: ['Calf'], work: ['Cover-up'] }],
    styles: ['Black & Grey realism', 'Colour realism'], design: [fixture('design.jpg')], existing: [fixture('existing.png')]
  });
  await noHorizontalScroll(page, 'desktop review');
  await send(page);
  const details = JSON.parse(finalSubmission(log).fields.projectDetails);
  assert.deepEqual(details.areas.map((a) => a.work), [['new'], ['cover_up']]);
  assert.deepEqual(details.styles, ['black_grey', 'colour']);
  if (crmDir) {
    assert.equal(log.rpc.filter((r) => r.name === 'create_trusted_enquiry_intake').length, 1, 'one enquiry');
    assert.equal(intake(log).p_enquiry.placement, 'Arm: Upper arm; Leg: Calf');
  }
  await context.close();
});

await test('6b exclusive choices: Not sure yet and No existing tattoo', async () => {
  const { page, context } = await openPage();
  await pick(page, 'Hand'); await next(page);
  await pick(page, 'Fingers'); await next(page);
  await pick(page, 'Cover-up'); await pick(page, 'Rework');
  await pick(page, 'No existing tattoo');
  assert.equal(await page.locator('input[value="cover_up"]').isChecked(), false);
  assert.equal(await page.locator('input[value="rework"]').isChecked(), false);
  await next(page);
  await pick(page, 'Colour realism'); await pick(page, 'Not sure yet');
  assert.equal(await page.locator('input[value="colour"]').isChecked(), false);
  assert.equal(await page.locator('#enquiry-v2').getByLabel(/^Existing tattoo details/).count(), 0, 'existing details hidden for new work');
  await context.close();
});

await test('7 missing required image is blocked in the browser', async () => {
  const { page, context, log } = await openPage();
  await pick(page, 'Leg'); await next(page);
  await pick(page, 'Thigh'); await next(page);
  await pick(page, 'No existing tattoo'); await next(page);
  await pick(page, 'Colour realism');
  await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill('Peony');
  await next(page);
  await next(page);
  assert.match(await errorText(page), /design reference/);
  assert.equal(await section(page), 'Images');
  assert.equal(log.requests.length, 0);
  await context.close();
});

await test('8 WhatsApp as the only contact, no email', async () => {
  const { page, context, log } = await openPage();
  await fillProject(page, { areas: [{ region: 'Chest & Ribs', placements: ['Ribs'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')], contact: { whatsapp: '07700 900123' } });
  await send(page);
  const submission = finalSubmission(log);
  assert.equal(submission.fields.preferredReply, 'WhatsApp');
  assert.equal(submission.fields.email, '');
  if (crmDir) {
    assert.equal(intake(log).p_client.email, null);
    assert.equal(intake(log).p_client.phone, '+447700900123');
  }
  await context.close();
});

await test('8b WhatsApp without country code is rejected before sending', async () => {
  const { page, context, log } = await openPage();
  await fillProject(page, { areas: [{ region: 'Foot', placements: ['Toes'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')], contact: { whatsapp: '612 345 678' } }).catch(() => {});
  assert.equal(await section(page), 'Contact');
  assert.match(await errorText(page), /country code/);
  assert.equal(log.requests.length, 0);
  await context.close();
});

await test('9 email with backup WhatsApp', async () => {
  const { page, context, log } = await openPage();
  await fillProject(page, { areas: [{ region: 'Neck & Head', placements: ['Behind the ear'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')], contact: { phone: '+34 612 345 678' } });
  await send(page);
  if (crmDir) {
    assert.equal(intake(log).p_client.email, 'vera@example.test');
    assert.equal(intake(log).p_client.phone, '+34612345678');
  } else {
    assert.equal(finalSubmission(log).fields.phone, '+34 612 345 678');
  }
  await context.close();
});

await test('10 back navigation keeps answers and photos; reload keeps text only', async () => {
  const { page, context } = await openPage();
  await fillProject(page, { areas: [{ region: 'Arm', placements: ['Wrist'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')], idea: 'Keep me' });
  for (let i = 0; i < 4; i += 1) await page.locator('#enquiry-v2').getByRole('button', { name: 'Back', exact: true }).click();
  await expectSection(page, 'Design');
  assert.equal(await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).inputValue(), 'Keep me');
  await next(page);
  await expectSection(page, 'Images');
  assert.equal(await page.locator('[data-image-role="design"] .ef-thumb').count(), 1, 'photo kept');
  await page.locator('[data-image-role="design"] .ef-thumb-remove').click();
  assert.equal(await page.locator('[data-image-role="design"] .ef-thumb').count(), 0, 'photo removed');
  await upload(page, 'design', [fixture('design.jpg')]);
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('.ef-notice:not([hidden])');
  await expectSection(page, 'Images');
  assert.ok(await page.getByText('photos need to be chosen again').count(), 're-select prompt');
  const stored = await page.evaluate(() => ({ local: localStorage.getItem('vishar.enquiry.v2.draft'), session: sessionStorage.getItem('vishar.enquiry.v2.contact') }));
  assert.match(stored.local, /Keep me/);
  assert.doesNotMatch(stored.local, /vera@example\.test|Vera Client/, 'no contact details in localStorage');
  assert.match(stored.session, /vera@example\.test/);
  await page.locator('#enquiry-v2').getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).inputValue(), 'Keep me');
  await page.evaluate(() => sessionStorage.setItem('vishar.enquiry.idempotencyKey', '11111111-2222-4333-8444-555555555555'));
  await page.getByRole('button', { name: 'Start over' }).click();
  await expectSection(page, 'Placement');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('vishar.enquiry.idempotencyKey')), null, 'Start over clears the retry key');
  await context.close();
});

await test('11 double Send creates one enquiry', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { page, context, log } = await openPage({
    intercept: async (control, entry) => { if (entry.fields.preflight !== '1') await gate; return false; },
  });
  await fillProject(page, { areas: [{ region: 'Stomach & Sides', placements: ['Side'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  await page.locator('.ef-consent').click();
  const button = page.locator('#enquiry-v2 .ef-btn-primary');
  await button.click();
  await button.click({ force: true }).catch(() => {});
  await button.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  release();
  await page.waitForSelector('#enquiry-success:not(.hidden)', { timeout: 20000 });
  assert.equal(log.requests.filter((r) => r.fields.preflight !== '1').length, 1);
  await context.close();
});

await test('12 dropped connection and 503 retry with the same key; 4xx clears the key', async () => {
  // a) A dropped connection: the request is retried and the enquiry lands once.
  let drops = 1;
  const dropped = await openPage({
    intercept: async (control, entry) => {
      if (entry.fields.preflight === '1' || drops === 0) return false;
      drops -= 1; control.abort(); return true;
    },
  });
  await fillProject(dropped.page, { areas: [{ region: 'Arm', placements: ['Elbow'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  await send(dropped.page);
  const droppedFinals = dropped.log.requests.filter((r) => r.fields.preflight !== '1');
  assert.ok(droppedFinals.length >= 2, 'retried after the drop');
  assert.equal(new Set(droppedFinals.map((r) => r.fields.idempotencyKey)).size, 1, 'same key on retry');
  await dropped.context.close();

  // b) Two 503s: one automatic retry, then Try again keeps the same key.
  let unavailable = 2;
  const { page, context, log } = await openPage({
    intercept: async (control, entry) => {
      if (entry.fields.preflight === '1' || unavailable === 0) return false;
      unavailable -= 1; control.fulfill(503, { ok: false, code: 'storage_upload_failed', error: 'We saved your details but could not store your images. Please try sending the form again.' }); return true;
    },
  });
  await fillProject(page, { areas: [{ region: 'Arm', placements: ['Elbow'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  await page.locator('.ef-consent').click();
  await next(page);
  await page.waitForFunction(() => /could not store your images/.test(document.getElementById('ef-error')?.textContent || ''), null, { timeout: 15000 });
  assert.equal(await page.locator('#enquiry-v2 .ef-btn-primary').textContent(), 'Try again');
  const keyBefore = await page.evaluate(() => sessionStorage.getItem('vishar.enquiry.idempotencyKey'));
  assert.ok(keyBefore, 'key kept after 5xx');
  assert.equal(log.requests.filter((r) => r.fields.preflight !== '1').length, 2, 'one automatic retry');
  await next(page);
  await page.waitForSelector('#enquiry-success:not(.hidden)', { timeout: 20000 });
  const all = log.requests.filter((r) => r.fields.preflight !== '1');
  assert.deepEqual([...new Set(all.map((r) => r.fields.idempotencyKey))], [keyBefore], 'same key across retries');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('vishar.enquiry.idempotencyKey')), null, 'key cleared after success');
  assert.equal(await page.evaluate(() => localStorage.getItem('vishar.enquiry.v2.draft')), null, 'draft cleared after success');
  await context.close();

  const second = await openPage({
    intercept: async (control, entry) => {
      if (entry.fields.preflight === '1') return false;
      control.fulfill(400, { ok: false, code: 'missing_design_reference', error: 'Please add at least one design reference image.' });
      return true;
    },
  });
  await fillProject(second.page, { areas: [{ region: 'Arm', placements: ['Elbow'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  await second.page.locator('.ef-consent').click();
  await next(second.page);
  await expectSection(second.page, 'Images');
  assert.match(await errorText(second.page), /design reference/);
  assert.equal(await second.page.evaluate(() => sessionStorage.getItem('vishar.enquiry.idempotencyKey')), null, '4xx clears key');
  await second.context.close();
});

await test('12b large iPhone photo is resized; unreadable file is refused', async () => {
  const { page, context, log } = await openPage();
  await pick(page, 'Back'); await next(page);
  await pick(page, 'Full back'); await next(page);
  await pick(page, 'No existing tattoo'); await next(page);
  await pick(page, 'Black & Grey realism');
  await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill('Angel');
  await next(page);
  await page.locator('[data-image-role="design"] input[type=file]').setInputFiles([fixture('not-image.jpg')]);
  await page.waitForFunction(() => /not a supported image|could not/.test(document.getElementById('ef-error')?.textContent || ''), null, { timeout: 15000 });
  await upload(page, 'design', [fixture('iphone-large.jpg')]);
  await next(page);
  await pick(page, 'Returning client'); await next(page);
  await contactEmail(page); await next(page);
  await send(page);
  const file = finalSubmission(log).files.designReferences[0];
  assert.equal(file.type, 'image/jpeg');
  assert.ok(file.size < 4 * 1024 * 1024, `resized to ${file.size}`);
  await context.close();
});

await test('13 UTM attribution and Meta/OpenAI consent handoff; Lead only after save', async () => {
  const { page, context, log } = await openPage({
    query: '&utm_source=meta&utm_medium=paid&utm_campaign=autumn&oppref=abc123',
    init: () => {
      localStorage.setItem('vishar-cookie-consent', 'granted');
      localStorage.setItem('vishar-meta-ads-consent', 'granted');
      localStorage.setItem('vishar-meta-ads-consent-version', '2026-10-08-capi');
      localStorage.setItem('vishar-openai-ads-consent', 'granted');
      document.cookie = '_fbp=fb.1.123.456; path=/';
      window.__leads = [];
      const wrap = () => {
        const original = window.fbq;
        if (!original || original.__wrapped) return;
        const wrapped = function () { if (arguments[2] === 'Lead') window.__leads.push(Array.from(arguments)); return original.apply(this, arguments); };
        Object.assign(wrapped, original); wrapped.__wrapped = true; window.fbq = wrapped;
      };
      setInterval(wrap, 20);
    },
  });
  await fillProject(page, { areas: [{ region: 'Arm', placements: ['Shoulder'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  assert.equal(await page.evaluate(() => window.__leads.length), 0, 'no Lead before submit');
  await send(page);
  const fields = finalSubmission(log).fields;
  if (process.env.DEBUG_INTAKE) console.log(JSON.stringify(fields));
  assert.equal(fields.utmSource, 'meta');
  assert.equal(fields.utmCampaign, 'autumn');
  assert.equal(fields.metaAdsMeasurementConsent, 'granted');
  assert.equal(fields.metaAdsFbp, 'fb.1.123.456');
  assert.equal(fields.openaiAdsMeasurementConsent, 'granted');
  assert.equal(fields.openaiAdsOppref, 'abc123');
  const leads = await page.evaluate(() => window.__leads);
  assert.equal(leads.length, 2, 'Lead on both Pixels after save');
  assert.ok(leads.every((call) => call[4] && call[4].eventID === fields.idempotencyKey), 'Lead uses the enquiry key for dedup');
  await context.close();

  const declined = await openPage({ init: () => { localStorage.setItem('vishar-cookie-consent', 'denied'); localStorage.setItem('vishar-meta-ads-consent', 'denied'); localStorage.setItem('vishar-openai-ads-consent', 'denied'); } });
  await fillProject(declined.page, { areas: [{ region: 'Arm', placements: ['Shoulder'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  await send(declined.page);
  const declinedFields = finalSubmission(declined.log).fields;
  assert.equal(declinedFields.metaAdsMeasurementConsent, undefined);
  assert.equal(declinedFields.openaiAdsMeasurementConsent, undefined);
  await declined.context.close();
});

await test('14 v2 is the default and ?enquiry_form=legacy is the rollback', async () => {
  const context = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/booking/`);
  await page.waitForSelector('.ef-choice');
  assert.equal(await page.locator('#tattoo-enquiry-form').isVisible(), false, 'legacy hidden by default');
  await page.goto(`${BASE}/booking/?enquiry_form=legacy`);
  assert.equal(await page.locator('#tattoo-enquiry-form').isVisible(), true, 'legacy visible with the override');
  assert.equal(await page.locator('#enquiry-v2').isVisible(), false);
  await context.close();
});

await test('15 keyboard only: select, continue, back', async () => {
  const { page, context } = await openPage({ device: 'desktop' });
  await page.locator('#ef-section').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('input[name="region"][value="arm"]').isChecked(), true, 'Space selects the focused card');
  const focusVisible = await page.evaluate(() => { const label = document.activeElement.closest('.ef-choice'); return label ? getComputedStyle(label).outlineStyle : 'none'; });
  assert.notEqual(focusVisible, 'none', 'focused card shows an outline');
  await page.keyboard.press('Enter');
  await expectSection(page, 'Details');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ef-section', 'focus moves to the new section');
  await context.close();
});

await test('16 accessibility (axe) and layout on every step, iPhone SE and iPhone 13', async () => {
  for (const device of ['iPhone SE', 'iPhone 13']) {
    // The consent UI is tested separately from the individual form steps.
    const { page, context } = await openPage({ device, init: () => { localStorage.setItem('vishar-cookie-consent', 'denied'); localStorage.setItem('vishar-meta-ads-consent', 'denied'); localStorage.setItem('vishar-meta-ads-consent-version', '2026-10-08-capi'); localStorage.setItem('vishar-openai-ads-consent', 'denied'); } });
    await page.evaluate(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    const checkStep = async (label) => {
      await page.waitForTimeout(350); // let the step transition finish
      await noHorizontalScroll(page, `${device} ${label}`);
      const small = await page.evaluate(() => Array.from(document.querySelectorAll('#enquiry-v2 button:not([hidden]), #enquiry-v2 label.ef-choice'))
        .filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect()).filter((r) => r.height < 44 && r.width > 0).length);
      assert.equal(small, 0, `${device} ${label}: touch targets under 44px`);
      {
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => (await window.axe.run('#enquiry-v2', { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ') + ' ' + (n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 160)).join(' | ')}`));
        if (violations.length) console.log(JSON.stringify(violations, null, 1));
        assert.deepEqual(violations, [], `${device} ${label}: axe`);
      }
    };
    await page.waitForLoadState('load');
    await page.waitForTimeout(600);
    await checkStep('placement');
    await pick(page, 'Arm'); await next(page); await checkStep('specific');
    await pick(page, 'Full sleeve'); await next(page); await checkStep('existing');
    await pick(page, 'Cover-up'); await next(page); await checkStep('design');
    await pick(page, 'Colour realism'); await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill('Koi'); await next(page); await checkStep('images');
    await upload(page, 'existing', [fixture('existing.png')]); await upload(page, 'design', [fixture('design.jpg')]);
    await checkStep('images with thumbnails');
    await next(page); await checkStep('discovery');
    await pick(page, 'Other'); await checkStep('discovery detail');
    await page.locator('#enquiry-v2').getByLabel(/^Where did you find Vladimir/).fill('A poster'); await next(page); await checkStep('contact');
    await contactEmail(page); await next(page); await checkStep('review');
    const cls = await page.evaluate(() => window.__cls);
    assert.ok(cls < 0.1, `${device}: CLS ${cls}`);
    await context.close();
  }
});

await test('17 Edit from review returns to review', async () => {
  const { page, context } = await openPage();
  await fillProject(page, { areas: [{ region: 'Arm', placements: ['Wrist'], work: ['No existing tattoo'] }], design: [fixture('design.jpg')] });
  await page.locator('.ef-summary-row', { hasText: 'Idea' }).locator('.ef-edit').click();
  await expectSection(page, 'Design');
  await page.locator('#enquiry-v2').getByLabel(/^Your tattoo idea/).fill('Changed idea');
  assert.equal(await page.locator('#enquiry-v2 .ef-btn-primary').textContent(), 'Back to review');
  await next(page);
  await expectSection(page, 'Review');
  assert.ok(await page.locator('.ef-summary').getByText('Changed idea').count());
  await context.close();
});

await test('18 first visit: body areas stay usable while consent is pending', async () => {
  for (const device of ['iPhone SE', 'iPhone 13', 'desktop']) {
    const { page, context } = await openPage({ device });
    try {
      const banner = page.locator('#booking-consent #cookie-consent');
      await banner.waitFor();
      const firstChoice = page.locator('.ef-choice').first();
      const choiceBounds = await firstChoice.boundingBox();
      const formBounds = await page.locator('.ef-form').boundingBox();
      const bannerBounds = await banner.boundingBox();
      assert.ok(choiceBounds.y + choiceBounds.height <= page.viewportSize().height,
        `${device}: first body area is fully above the fold`);
      assert.ok(bannerBounds.y >= formBounds.y + formBounds.height || bannerBounds.x >= formBounds.x + formBounds.width,
        `${device}: consent and form do not overlap`);

      await pick(page, 'Arm');
      await next(page);
      await expectSection(page, 'Details');
      assert.equal(await banner.isVisible(), true, 'a choice is optional to continue');
      await banner.getByRole('button', { name: 'Decline' }).click();
      await banner.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => localStorage.getItem('vishar-cookie-consent')), 'denied');
    } finally {
      await context.close();
    }
  }
});

await browser.close();
server.close();
intakeServer.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser scenarios passed (${backend.name}).`);
if (failed.length) process.exit(1);
