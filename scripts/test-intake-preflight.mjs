#!/usr/bin/env node
// Intake semantic preflight: contract, fail-open provider handling and the
// preflight mode of the shared intake endpoint. No network: fetch is stubbed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../workers/tattooai.js';
import { INTAKE_PREFLIGHT_BROWSER_JS } from '../workers/lib/intake-preflight/browser-client.js';
import { __testing as hosted } from '../workers/routes/hosted-booking.js';
import { __testing as slug } from '../workers/routes/public-booking.js';
import {
  CLARIFICATION_TEMPLATES, CLARIFY_CATEGORIES, PREFLIGHT_VERSION, buildPreflightQuestions,
  buildPreflightState, clarificationMessages, decidePreflight,
} from '../workers/lib/intake-preflight/contract.js';
import { preflightConfig, runIntakePreflight } from '../workers/lib/intake-preflight/provider.js';

let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const KEY = 'k'.repeat(40);
const ON = { INTAKE_PREFLIGHT_ENABLED: 'true', INTAKE_PREFLIGHT_PROVIDER: 'jev', DECISION_MODEL_API_KEY: KEY };
const fields = {
  projectType: 'New tattoo', placement: 'arm', size: 'medium', idea: 'realistic lion with flowers', coverUp: 'No', referenceCount: 1,
};
const answers = (p = {}) => ({
  placement_clear: { noul: p.placement ?? 0.95 }, size_clear: { noul: p.size ?? 0.95 },
  idea_clear: { noul: p.idea ?? 0.95 }, artist_review: { noul: p.review ?? 0.05 },
  ...(p.coverup !== undefined ? { coverup_goal_clear: { noul: p.coverup } } : {}),
});
const providerOk = (a) => async () => Response.json({ answers: a, model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', usage: { cost: 0.00004 } });

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

await test('the provider sees only the minimal payload', () => {
  const state = buildPreflightState({ ...fields, name: 'Private Person', email: 'p@example.test', phone: '+44', referenceCount: 9 });
  assert.deepEqual(Object.keys(state).sort(), ['cover_up', 'idea', 'placement', 'project_type', 'reference_image_count', 'size']);
  assert.equal(state.reference_image_count, 3);
  assert.ok(!JSON.stringify(state).includes('Private Person'));
  assert.equal(buildPreflightState({ ...fields, idea: 'x'.repeat(5000) }).idea.length, 2000);
});

await test('the cover-up question is asked only for a cover-up', () => {
  assert.equal('coverup_goal_clear' in buildPreflightQuestions(buildPreflightState(fields)), false);
  assert.equal('coverup_goal_clear' in buildPreflightQuestions(buildPreflightState({ ...fields, coverUp: 'Not sure' })), true);
  for (const q of Object.values(buildPreflightQuestions(buildPreflightState({ ...fields, coverUp: 'Yes' })))) assert.equal(q.type, 'noul');
});

await test('only confidently unclear fields become hints; the brief example asks for placement and size', () => {
  const state = buildPreflightState(fields);
  assert.deepEqual(decidePreflight(answers({ placement: 0.05, size: 0.1 }), state), { status: 'clarify', categories: ['placement', 'size'] });
  assert.deepEqual(decidePreflight(answers({ placement: 0.35 }), state), { status: 'ready', categories: [] });
  assert.deepEqual(decidePreflight(answers(), state), { status: 'ready', categories: [] });
});

await test('artist review wins over clarification and is a success', () => {
  const d = decidePreflight(answers({ review: 0.9, idea: 0.05 }), buildPreflightState(fields));
  assert.deepEqual(d, { status: 'artist_review', categories: [] });
});

await test('a malformed or incomplete answer is skipped and never asks the client anything', () => {
  const state = buildPreflightState(fields);
  for (const bad of [
    null,
    'x',
    {},
    { placement_clear: { noul: 'low' } },
    { size_clear: { noul: -1 } },
    { idea_clear: null },
    { ...answers(), artist_review: undefined },
    { ...answers(), size_clear: undefined },
  ]) {
    assert.equal(decidePreflight(bad, state).status, 'skipped');
  }
  const coverupState = buildPreflightState({ ...fields, coverUp: 'Yes' });
  assert.equal(decidePreflight(answers(), coverupState).status, 'skipped');
});

await test('at most three hints, all server-owned text', () => {
  const state = buildPreflightState({ ...fields, coverUp: 'Yes' });
  const d = decidePreflight(answers({ placement: 0, size: 0, idea: 0, coverup: 0 }), state);
  assert.equal(d.categories.length, 3);
  const messages = clarificationMessages(d.categories);
  for (const m of messages) assert.equal(m.text, CLARIFICATION_TEMPLATES[m.category].text);
  assert.deepEqual(clarificationMessages(['price', 'placement']).map((m) => m.category), ['placement']);
  for (const c of CLARIFY_CATEGORIES) assert.ok(!/£|\$|price|available|book|deposit/i.test(CLARIFICATION_TEMPLATES[c].text));
});

await test('the browser preserves multiple server hints that target the same field', () => {
  assert.ok(INTAKE_PREFLIGHT_BROWSER_JS.includes("querySelectorAll('[data-preflight-hint=\\\"'+field+'\\\"]')"));
  assert.ok(!INTAKE_PREFLIGHT_BROWSER_JS.includes("if(old)old.remove()"));
});

await test('replayed completed intakes still mark the preflight as submitted', () => {
  const source = readFileSync(new URL('../workers/routes/enquiries.js', import.meta.url), 'utf8');
  const start = source.indexOf("if (intake.replayed && intake.intake_state === 'complete')");
  const end = source.indexOf('const cleanupPaths = new Set()', start);
  assert.ok(start >= 0 && end > start);
  const replayBlock = source.slice(start, end);
  assert.match(replayBlock, /markPreflightSubmitted\(supabase, preflightFollowUp, enquiryId, schedule\)/);
});

// ---------------------------------------------------------------------------
// Provider: fail-open everywhere
// ---------------------------------------------------------------------------

await test('off by default, and off without a provider or key', () => {
  assert.equal(preflightConfig({}).enabled, false);
  assert.equal(preflightConfig({ INTAKE_PREFLIGHT_ENABLED: 'true' }).reason, 'no_provider');
  assert.equal(preflightConfig({ INTAKE_PREFLIGHT_ENABLED: 'true', INTAKE_PREFLIGHT_PROVIDER: 'jev' }).reason, 'not_configured');
  assert.equal(preflightConfig(ON).timeoutMs, 1200);
  assert.equal(preflightConfig({ ...ON, INTAKE_PREFLIGHT_TIMEOUT_MS: '50' }).timeoutMs, 300);
});

await test('every provider failure is skipped, never a hint', async () => {
  const cases = [
    async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
    async () => new Response('x', { status: 429 }),
    async () => new Response('x', { status: 503 }),
    async () => new Response('not json'),
    async () => Response.json({ nothing: true }),
    async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } }),
  ];
  for (const fetchImpl of cases) {
    const r = await runIntakePreflight(ON, fields, { fetchImpl });
    assert.equal(r.status, 'skipped');
    assert.deepEqual(r.messages, []);
  }
  let called = false;
  const off = await runIntakePreflight({}, fields, { fetchImpl: async () => { called = true; } });
  assert.equal(off.status, 'skipped');
  assert.equal(off.outcome, 'disabled');
  assert.equal(called, false, 'nothing leaves the Worker while the switch is off');
});

await test('a clarification carries categories and templates, never probabilities', async () => {
  const seen = [];
  const r = await runIntakePreflight(ON, fields, {
    fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return providerOk(answers({ placement: 0.02, size: 0.05 }))(); },
  });
  assert.equal(r.status, 'clarify');
  assert.deepEqual(r.categories, ['placement', 'size']);
  assert.equal(r.version, PREFLIGHT_VERSION);
  assert.ok(!JSON.stringify(r).includes('0.02'));
  assert.equal(seen[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(Object.keys(seen[0].body.state).sort(), ['cover_up', 'idea', 'placement', 'project_type', 'reference_image_count', 'size']);
});

// ---------------------------------------------------------------------------
// Endpoint: preflight mode of the shared intake route
// ---------------------------------------------------------------------------

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  BOOKING_SOURCE_KEY: 'vladimir-website',
  BOOKING_FORM_VERSION: 'booking-v1',
};

function preflightForm(overrides = {}) {
  const form = new FormData();
  const values = {
    idempotencyKey: '11111111-2222-4333-8444-555555555555', name: 'Test Client', email: 'client@example.test',
    preferredReply: 'Email', projectType: 'New tattoo', placement: 'arm', size: 'medium', coverUp: 'No',
    idea: 'realistic lion with flowers', website: '', privacyAcknowledged: 'true', privacyNoticeVersion: '2026-07-29',
    preflight: '1', referenceCount: '1', ...overrides,
  };
  for (const [k, v] of Object.entries(values)) form.append(k, v);
  return form;
}

async function callPreflight(env, form, providerFetch) {
  const rpcs = [];
  const waits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/rest/v1/rpc/')) {
      rpcs.push({ name: href.split('/rest/v1/rpc/')[1], args: JSON.parse(init.body || '{}') });
      return Response.json(null);
    }
    if (href.startsWith('https://openrouter.ai/')) return providerFetch(url, init);
    if (href.includes('/storage/')) throw new Error('storage must not be touched by a preflight');
    throw new Error(`unexpected fetch ${href}`);
  };
  try {
    const response = await worker.fetch(
      new Request('https://tattooai.vvetrov41.workers.dev/', { method: 'POST', headers: { Origin: 'https://vishartattoo.com' }, body: form }),
      env, { waitUntil: (p) => waits.push(p) },
    );
    await Promise.all(waits);
    return { status: response.status, body: await response.json(), rpcs };
  } finally {
    globalThis.fetch = realFetch;
  }
}

await test('a preflight never persists: no intake RPC, no files, one metadata row', async () => {
  const r = await callPreflight({ ...ENV, ...ON }, preflightForm(), providerOk(answers({ placement: 0.03, size: 0.04 })));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.preflight.status, 'clarify');
  assert.deepEqual(r.body.preflight.messages.map((m) => m.field), ['placement', 'size']);
  assert.match(r.body.preflight.id, /^[0-9a-f-]{36}$/);
  const names = r.rpcs.map((c) => c.name);
  assert.ok(!names.some((n) => /create_.*enquiry_intake|finalize|mark_enquiry_file/.test(n)), names.join(','));
  const telemetry = r.rpcs.filter((c) => c.name === 'service_record_intake_preflight');
  assert.equal(telemetry.length, 1);
  const event = telemetry[0].args.p_event;
  assert.deepEqual(Object.keys(event).sort(), ['categories', 'form_path', 'id', 'latency_ms', 'outcome', 'provider', 'status', 'version']);
  assert.equal(event.form_path, 'external');
  assert.ok(!JSON.stringify(event).includes('lion') && !JSON.stringify(event).includes('client@example.test'));
});

await test('with the switch off a preflight answers skipped and calls no provider', async () => {
  const r = await callPreflight(ENV, preflightForm(), async () => { throw new Error('provider must not be called'); });
  assert.equal(r.body.preflight.status, 'skipped');
  assert.deepEqual(r.body.preflight.messages, []);
});

await test('deterministic validation still runs first: a bad email is a normal 400, not a preflight', async () => {
  const r = await callPreflight({ ...ENV, ...ON }, preflightForm({ email: 'not-an-email' }), async () => { throw new Error('no'); });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
});

await test('a provider outage still lets the client submit (skipped)', async () => {
  const r = await callPreflight({ ...ENV, ...ON }, preflightForm(), async () => new Response('x', { status: 500 }));
  assert.equal(r.body.preflight.status, 'skipped');
});

// ---------------------------------------------------------------------------
// Forms: one browser module, off by default everywhere
// ---------------------------------------------------------------------------

await test('the static booking page loads the same browser module the Worker inlines', () => {
  assert.equal(readFileSync(new URL('../assets/js/intake-preflight.js', import.meta.url), 'utf8'), INTAKE_PREFLIGHT_BROWSER_JS,
    'regenerate assets/js/intake-preflight.js from workers/lib/intake-preflight/browser-client.js');
  assert.ok(!INTAKE_PREFLIGHT_BROWSER_JS.includes('</script'));
  assert.doesNotThrow(() => new Function(INTAKE_PREFLIGHT_BROWSER_JS));
});

await test('the Vladimir booking page ships with the preflight switched off', () => {
  const html = readFileSync(new URL('../booking/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="vishar-intake-preflight" content="">/);
  assert.match(html, /<script src="\/assets\/js\/intake-preflight\.js"><\/script>/);
  assert.match(html, /preflight\.gate\(payload\)/);
});

await test('hosted and slug forms inline the module only when the Worker switch is on', () => {
  const meta = { artist_display_name: 'Test Artist', template_key: 'tattoo-enquiry', form_version: 'booking-v1', title: 'Book' };
  const id = '11111111-2222-4333-8444-555555555555';
  const hostedOff = hosted.renderHostedForm(meta, id);
  const hostedOn = hosted.renderHostedForm(meta, id, { preflight: true });
  assert.ok(!hostedOff.includes('VisharIntakePreflight={'));
  assert.ok(hostedOn.includes('VisharIntakePreflight={'));
  assert.ok(hostedOn.includes('preflight.gate(payload)'));
  const slugOff = slug.renderPublicForm('test-artist');
  const slugOn = slug.renderPublicForm('test-artist', { preflight: true });
  assert.ok(!slugOff.includes('VisharIntakePreflight={'));
  assert.ok(slugOn.includes('VisharIntakePreflight={') && slugOn.includes("endpoint:'/book/test-artist'"));
});

if (!process.exitCode) console.log(`intake preflight: ${passes} tests passed`);
