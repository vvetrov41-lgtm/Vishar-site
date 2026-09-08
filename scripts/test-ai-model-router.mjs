#!/usr/bin/env node
//
// Unit tests for the model capability router and its provider adapters.
//
// What these pin down:
//
//   * a caller names a task, never a provider;
//   * DeepSeek serves the cheap text classes and Qwen the multimodal ones;
//   * OpenAI stays reachable as the quality tier and cross-provider fallback;
//   * the incumbent Workers AI path still answers when nothing else is
//     configured, which is what keeps the live public site working;
//   * one attempt per provider and at most two providers per request;
//   * timeouts, provider errors and unparseable structured output fall back
//     once and then fail closed;
//   * telemetry carries operational tokens only, never prompts, images or keys;
//   * no provider credential can reach a browser response.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(rootDir, 'workers', rel)).href);

const router = await load('lib/ai/router.js');
const tasks = await load('lib/ai/tasks.js');
const errors = await load('lib/ai/errors.js');
const deepseek = await load('lib/ai/providers/deepseek.js');
const qwen = await load('lib/ai/providers/qwen.js');
const openai = await load('lib/ai/providers/openai.js');
const workersAi = await load('lib/ai/providers/workers-ai.js');
const logging = await load('lib/logging.js');
const observability = await load('lib/observability.js');
const probe = await load('routes/ai-router-probe.js');
const worker = (await load('tattooai-entry.js')).default;

// Router telemetry is deliberately noisy on the failure paths these tests
// exercise. Keep the suite output to its results.
const realConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
console.warn = () => {};
console.error = () => {};

let failures = 0;
let passes = 0;

async function test(name, fn) {
  try {
    await fn();
    passes += 1;
  } catch (error) {
    failures += 1;
    realConsole.error(`FAIL ${name}`);
    realConsole.error(`     ${error.stack ?? error.message}`);
  }
}

// --- fixtures ---------------------------------------------------------------

const KEY = 'test-provider-key-0000000000';
const SYSTEM = 'You are a test system prompt.';
const INPUT = 'A wolf in moonlight.';
const PNG_BASE64 = probe.__testing.PROBES.vision_reference_understanding.images[0].dataBase64;

function chatResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
  };
}

function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responder(url, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function workersAiBinding(text = 'Concept: a raven.') {
  const calls = [];
  return {
    calls,
    AI: {
      run: async (model, options) => {
        calls.push({ model, options });
        return { response: text };
      },
    },
  };
}

function collectingLogger() {
  const lines = [];
  const push = (level) => (event, fields = {}) => lines.push({ level, ...logging.redact({ ...fields, event }) });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

const textInput = { system: SYSTEM, input: INPUT };
const visionInput = { system: SYSTEM, input: INPUT, images: [{ mimeType: 'image/png', dataBase64: PNG_BASE64 }] };

// --- capability registry ----------------------------------------------------

await test('every declared task resolves to known providers and bounded limits', () => {
  for (const name of tasks.TASK_NAMES) {
    const plan = tasks.resolveTask({}, name, router.PROVIDER_IDS);
    assert.ok(plan, `${name} must resolve`);
    assert.ok(plan.chain.length >= 1 && plan.chain.length <= tasks.MAX_PROVIDERS_PER_REQUEST);
    for (const id of plan.chain) {
      assert.ok(router.PROVIDER_IDS.has(id), `${name} routes to unknown provider ${id}`);
      assert.ok(
        router.PROVIDERS[id].modalities.has(plan.modality),
        `${name} routes ${plan.modality} work to ${id}, which cannot serve it`,
      );
    }
    assert.ok(plan.timeoutMs > 0 && plan.timeoutMs <= tasks.MAX_TIMEOUT_MS);
    assert.ok(plan.maxOutputTokens > 0 && plan.maxOutputTokens <= tasks.MAX_OUTPUT_TOKENS);
  }
});

await test('DeepSeek leads the cheap text classes and Qwen leads the multimodal ones', () => {
  for (const name of ['concept_consult', 'aftercare_support', 'text_summarization', 'text_classification', 'text_extraction']) {
    assert.equal(tasks.resolveTask({}, name, router.PROVIDER_IDS).chain[0], 'deepseek', name);
  }
  for (const name of ['vision_reference_understanding', 'vision_document_extraction']) {
    assert.equal(tasks.resolveTask({}, name, router.PROVIDER_IDS).chain[0], 'qwen', name);
  }
  // Quality-sensitive judgement stays on OpenAI by default.
  assert.equal(tasks.resolveTask({}, 'high_quality_reasoning', router.PROVIDER_IDS).chain[0], 'openai');
  // Both live public chains must end on the existing Cloudflare binding.
  assert.equal(tasks.resolveTask({}, 'concept_consult', router.PROVIDER_IDS).chain.at(-1), 'workers_ai');
  assert.equal(tasks.resolveTask({}, 'aftercare_support', router.PROVIDER_IDS).chain.at(-1), 'workers_ai');
});

await test('server-side route overrides apply, and invalid ones are ignored', () => {
  const overridden = tasks.resolveTask(
    { AI_ROUTE_CONCEPT_CONSULT: 'openai, workers_ai' }, 'concept_consult', router.PROVIDER_IDS);
  assert.deepEqual([...overridden.chain], ['openai', 'workers_ai']);
  assert.equal(overridden.routeSource, 'env');

  for (const bad of ['', 'not_a_provider', 'deepseek,deepseek', 'deepseek,openai,workers_ai', '../etc']) {
    const plan = tasks.resolveTask({ AI_ROUTE_CONCEPT_CONSULT: bad }, 'concept_consult', router.PROVIDER_IDS);
    assert.deepEqual([...plan.chain], ['deepseek', 'workers_ai'], `override "${bad}" must be ignored`);
    assert.equal(plan.routeSource, 'default');
  }
});

await test('an unknown task never reaches a provider', async () => {
  const fetchImpl = recordingFetch(() => chatResponse('never'));
  const result = await router.runModelTask({ DEEPSEEK_API_KEY: KEY }, 'no_such_task', textInput, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'task_unknown');
  assert.equal(fetchImpl.calls.length, 0);
});

// --- DeepSeek adapter -------------------------------------------------------

await test('the DeepSeek adapter builds a bounded DeepSeek request and normalises the reply', async () => {
  const fetchImpl = recordingFetch(() => chatResponse('  Concept: a wolf.  '));
  const result = await router.runModelTask({ DEEPSEEK_API_KEY: KEY }, 'concept_consult', textInput, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, deepseek.__testing.DEFAULT_TEXT_MODEL);
  assert.equal(result.text, 'Concept: a wolf.');
  assert.equal(result.fallbackUsed, false);

  const [call] = fetchImpl.calls;
  assert.equal(call.url, deepseek.__testing.DEFAULT_URL);
  assert.equal(call.options.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.body.model, 'deepseek-chat');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.max_tokens, tasks.resolveTask({}, 'concept_consult', router.PROVIDER_IDS).maxOutputTokens);
  assert.deepEqual(call.body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(call.body.messages[1].content, INPUT);
});

await test('the DeepSeek model id is server-configurable but validated', () => {
  assert.equal(deepseek.configure({ DEEPSEEK_API_KEY: KEY, AI_MODEL_DEEPSEEK_TEXT: 'deepseek-reasoner' }, 'text').model, 'deepseek-reasoner');
  assert.equal(deepseek.configure({ DEEPSEEK_API_KEY: KEY, AI_MODEL_DEEPSEEK_TEXT: 'bad model/../x' }, 'text').model, 'deepseek-chat');
  assert.equal(deepseek.configure({ DEEPSEEK_API_KEY: 'short' }, 'text'), null);
  assert.equal(deepseek.configure({ DEEPSEEK_API_KEY: KEY }, 'vision'), null, 'DeepSeek must never take image work');
});

// --- Qwen adapter -----------------------------------------------------------

await test('the Qwen adapter carries the image to DashScope and normalises content parts', async () => {
  const fetchImpl = recordingFetch(() => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: [{ text: 'Red.' }] }, finish_reason: 'stop' }],
    }),
  }));
  const result = await router.runModelTask(
    { QWEN_API_KEY: KEY }, 'vision_reference_understanding', visionInput, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'qwen');
  assert.equal(result.model, 'qwen-vl-plus');
  assert.equal(result.text, 'Red.');

  const [call] = fetchImpl.calls;
  assert.equal(call.url, qwen.__testing.DEFAULT_URL);
  const parts = call.body.messages[1].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.ok(parts[1].image_url.url.startsWith('data:image/png;base64,'));
});

await test('the Qwen base URL stays inside DashScope', () => {
  assert.equal(qwen.configure({ QWEN_API_KEY: KEY, AI_QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' }, 'vision').url,
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(qwen.configure({ QWEN_API_KEY: KEY, AI_QWEN_BASE_URL: 'https://attacker.example/collect' }, 'vision').url,
    qwen.__testing.DEFAULT_URL);
});

await test('image payloads are bounded before any provider is paid', async () => {
  const fetchImpl = recordingFetch(() => chatResponse('never'));
  const env = { QWEN_API_KEY: KEY };
  const oversized = 'A'.repeat(Math.ceil((tasks.MAX_IMAGE_BYTES + 1024) * 4 / 3));

  const cases = [
    { system: SYSTEM, input: INPUT, images: [] },
    { system: SYSTEM, input: INPUT, images: [{ mimeType: 'image/gif', dataBase64: PNG_BASE64 }] },
    { system: SYSTEM, input: INPUT, images: [{ mimeType: 'image/png', dataBase64: 'not base64!!' }] },
    { system: SYSTEM, input: INPUT, images: [{ mimeType: 'image/png', dataBase64: oversized }] },
    {
      system: SYSTEM,
      input: INPUT,
      images: Array.from({ length: tasks.MAX_IMAGES + 1 }, () => ({ mimeType: 'image/png', dataBase64: PNG_BASE64 })),
    },
    { system: SYSTEM, input: 'x'.repeat(tasks.MAX_INPUT_CHARS + 1), images: [{ mimeType: 'image/png', dataBase64: PNG_BASE64 }] },
  ];

  for (const input of cases) {
    const result = await router.runModelTask(env, 'vision_reference_understanding', input, { fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'request_invalid');
  }
  assert.equal(fetchImpl.calls.length, 0, 'a rejected request must never be sent');
});

await test('a text task refuses images rather than silently dropping them', async () => {
  const fetchImpl = recordingFetch(() => chatResponse('never'));
  const result = await router.runModelTask({ DEEPSEEK_API_KEY: KEY }, 'concept_consult', visionInput, { fetchImpl });
  assert.equal(result.errorCode, 'request_invalid');
  assert.equal(fetchImpl.calls.length, 0);
});

// --- OpenAI fallback --------------------------------------------------------

await test('OpenAI takes over when Qwen fails, exactly once', async () => {
  const fetchImpl = recordingFetch((url) => (url.includes('aliyuncs.com')
    ? chatResponse('', 503)
    : chatResponse('A red square.')));

  const result = await router.runModelTask(
    { QWEN_API_KEY: KEY, OPENAI_API_KEY: KEY }, 'vision_reference_understanding', visionInput, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'openai');
  assert.equal(result.fallbackUsed, true);
  assert.equal(fetchImpl.calls.length, 2, 'one attempt per provider, no retry loop');
  assert.deepEqual(result.attempts.map((a) => `${a.provider}:${a.outcome}`), ['qwen:failed', 'openai:succeeded']);
  assert.equal(result.attempts[0].errorCode, 'provider_unavailable');
});

await test('OpenAI leads high-quality reasoning and DeepSeek backs it up', async () => {
  const fetchImpl = recordingFetch((url) => (url.includes('openai.com')
    ? chatResponse('', 429)
    : chatResponse('Considered answer.')));

  const result = await router.runModelTask(
    { OPENAI_API_KEY: KEY, DEEPSEEK_API_KEY: KEY }, 'high_quality_reasoning', textInput, { fetchImpl });

  assert.equal(result.provider, 'deepseek');
  assert.equal(result.attempts[0].provider, 'openai');
  assert.equal(result.attempts[0].errorCode, 'provider_rate_limited');
});

// --- incumbent Workers AI path ---------------------------------------------

await test('with no external keys the live chain still lands on the Cloudflare binding', async () => {
  const binding = workersAiBinding();
  const fetchImpl = recordingFetch(() => { throw new Error('the incumbent path must not use fetch'); });

  const result = await router.runModelTask({ AI: binding.AI }, 'concept_consult', textInput, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'workers_ai');
  assert.equal(result.model, '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(result.fallbackUsed, false, 'an unconfigured provider is skipped, not attempted');
  assert.equal(binding.calls[0].model, '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(binding.calls[0].options.messages[1].content, INPUT);
  assert.equal(fetchImpl.calls.length, 0);
});

await test('DeepSeek failure falls back to the Cloudflare binding on the live chain', async () => {
  const binding = workersAiBinding('Concept: a fallback raven.');
  const fetchImpl = recordingFetch(() => chatResponse('', 500));

  const result = await router.runModelTask(
    { AI: binding.AI, DEEPSEEK_API_KEY: KEY }, 'concept_consult', textInput, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'workers_ai');
  assert.equal(result.text, 'Concept: a fallback raven.');
  assert.equal(result.fallbackUsed, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(binding.calls.length, 1);
});

await test('nothing configured is reported, not thrown', async () => {
  const result = await router.runModelTask({}, 'concept_consult', textInput, { fetchImpl: recordingFetch(() => chatResponse('x')) });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'no_provider_configured');
});

// --- timeouts, exhaustion and structured output -----------------------------

await test('a hung provider times out and the chain moves on once', async () => {
  const binding = workersAiBinding('Recovered.');
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const env = {
    AI: binding.AI,
    DEEPSEEK_API_KEY: KEY,
    AI_ROUTE_CONCEPT_CONSULT: 'deepseek,workers_ai',
  };
  const started = Date.now();
  const result = await router.runModelTask(env, 'concept_consult', textInput, { fetchImpl });
  assert.ok(Date.now() - started < 25_000, 'the timeout must bound the request');
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].errorCode, 'provider_timeout');
  assert.equal(result.provider, 'workers_ai');
});

await test('a chain that fails everywhere fails closed without throwing', async () => {
  const fetchImpl = recordingFetch(() => chatResponse('', 500));
  const result = await router.runModelTask(
    { QWEN_API_KEY: KEY, OPENAI_API_KEY: KEY }, 'vision_reference_understanding', visionInput, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'all_providers_failed');
  assert.equal(result.attempts.length, 2);
  assert.equal(fetchImpl.calls.length, 2, 'the cap holds even when every provider fails');
});

await test('unparseable structured output is a failure, and a fenced object is not', async () => {
  const bad = recordingFetch(() => chatResponse('Sure! Here is the answer.'));
  const failed = await router.runModelTask(
    { DEEPSEEK_API_KEY: KEY, OPENAI_API_KEY: KEY }, 'text_classification', textInput,
    { fetchImpl: bad, requiredKeys: ['label'] });
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'all_providers_failed');
  assert.deepEqual(failed.attempts.map((a) => a.errorCode), ['output_invalid', 'output_invalid']);

  const mixed = recordingFetch((url) => (url.includes('deepseek')
    ? chatResponse('not json')
    : chatResponse('```json\n{"label":"cover_up"}\n```')));
  const recovered = await router.runModelTask(
    { DEEPSEEK_API_KEY: KEY, OPENAI_API_KEY: KEY }, 'text_classification', textInput,
    { fetchImpl: mixed, requiredKeys: ['label'] });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.provider, 'openai');
  assert.deepEqual(recovered.json, { label: 'cover_up' });

  const missingKey = recordingFetch(() => chatResponse('{"other":"value"}'));
  const rejected = await router.runModelTask(
    { DEEPSEEK_API_KEY: KEY }, 'text_classification', textInput,
    { fetchImpl: missingKey, requiredKeys: ['label'] });
  assert.equal(rejected.ok, false);
});

await test('a structured task asks the provider for JSON', async () => {
  const fetchImpl = recordingFetch(() => chatResponse('{"label":"x"}'));
  await router.runModelTask({ DEEPSEEK_API_KEY: KEY }, 'text_classification', textInput,
    { fetchImpl, requiredKeys: ['label'] });
  assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: 'json_object' });

  const plain = recordingFetch(() => chatResponse('prose'));
  await router.runModelTask({ DEEPSEEK_API_KEY: KEY }, 'concept_consult', textInput, { fetchImpl: plain });
  assert.equal(plain.calls[0].body.response_format, undefined);
});

await test('a malformed provider body is rejected rather than parsed loosely', async () => {
  for (const body of ['not json', '{}', JSON.stringify({ choices: [{ message: { content: '   ' } }] })]) {
    const fetchImpl = recordingFetch(() => ({ ok: true, status: 200, text: async () => body }));
    const result = await router.runModelTask({ DEEPSEEK_API_KEY: KEY }, 'concept_consult', textInput, { fetchImpl });
    assert.equal(result.ok, false, `body "${body}" must not be accepted`);
  }
});

await test('every provider error code is in the declared taxonomy', () => {
  const known = new Set([...errors.PROVIDER_ERROR_CODES, 'task_unknown', 'request_invalid', 'no_provider_configured', 'all_providers_failed']);
  assert.ok(known.has(errors.providerErrorCodeForStatus(429)));
  assert.equal(errors.providerErrorCodeForStatus(429), 'provider_rate_limited');
  assert.equal(errors.providerErrorCodeForStatus(503), 'provider_unavailable');
  assert.equal(errors.providerErrorCodeForStatus(404), 'provider_http_error');
  assert.equal(new errors.ProviderError('nonsense').code, 'provider_unavailable');
});

// --- telemetry --------------------------------------------------------------

await test('telemetry identifies the route without carrying content or credentials', async () => {
  const logger = collectingLogger();
  const binding = workersAiBinding('Concept: a raven with a long descriptive answer.');
  const fetchImpl = recordingFetch(() => chatResponse('', 429));

  const result = await router.runModelTask(
    { AI: binding.AI, DEEPSEEK_API_KEY: KEY }, 'concept_consult', textInput, { fetchImpl, logger });

  const completed = logger.lines.find((line) => line.event === 'ai.router.completed');
  assert.ok(completed, 'a completed event must be emitted');
  assert.equal(completed.task, 'concept_consult');
  assert.equal(completed.capability, 'drafting');
  assert.equal(completed.provider, 'workers_ai');
  assert.equal(completed.model, 'cf-meta-llama-3.1-8b-instruct');
  assert.equal(completed.fallbackUsed, true);
  assert.equal(completed.providerAttempts, 2);
  assert.ok(typeof completed.durationMs === 'number');
  assert.equal(completed.outputChars, result.text.length);

  const attempt = logger.lines.find((line) => line.event === 'ai.router.attempt' && line.provider === 'deepseek');
  assert.equal(attempt.errorCode, 'provider_rate_limited');

  const serialized = JSON.stringify(logger.lines);
  for (const forbidden of [KEY, SYSTEM, INPUT, 'Bearer', 'raven']) {
    assert.ok(!serialized.includes(forbidden), `telemetry must not contain "${forbidden}"`);
  }
});

await test('routing telemetry survives the external observability sanitizer', () => {
  const payload = observability.sanitizeOperationalEvent({
    event: 'ai.router.completed',
    operation: 'vision_reference_understanding',
    provider: 'qwen',
    model: router.modelToken('@cf/meta/llama-3.1-8b-instruct'),
    fallbackUsed: 'yes',
    outcome: 'succeeded',
    durationMs: 120,
  });
  assert.deepEqual(payload, {
    event: 'ai.router.completed',
    operation: 'vision_reference_understanding',
    provider: 'qwen',
    model: 'cf-meta-llama-3.1-8b-instruct',
    fallbackUsed: 'yes',
    outcome: 'succeeded',
    durationMs: 120,
  });

  // The sanitizer must still refuse anything that is not an operational token.
  assert.deepEqual(
    observability.sanitizeOperationalEvent({ event: 'ai.router.completed', model: 'a wolf in moonlight' }),
    { event: 'ai.router.completed' },
  );
});

// --- browser boundary and the guarded probe ---------------------------------

const ENDPOINT = 'https://tattooai.vvetrov41.workers.dev/';
const ORIGIN = 'https://vishartattoo.com';
const ctx = { waitUntil: () => {} };

async function post(path, options = {}, env = {}) {
  const request = new Request(`${ENDPOINT.replace(/\/$/, '')}${path}`, {
    method: options.method ?? 'POST',
    headers: options.headers ?? { 'content-type': 'application/json' },
    body: options.body,
  });
  const response = await worker.fetch(request, env, ctx);
  return { response, payload: await response.json().catch(() => ({})) };
}

await test('the public assistant response exposes no provider, model or credential', async () => {
  const binding = workersAiBinding('Concept: a raven.');
  const env = { ...binding, DEEPSEEK_API_KEY: KEY, QWEN_API_KEY: KEY, OPENAI_API_KEY: KEY };
  // Every external provider is "configured" but unreachable; the site must still answer.
  globalThis.fetch = async () => { throw new Error('network down'); };

  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ type: 'idea', message: 'A wolf' }),
  });
  const response = await worker.fetch(request, env, ctx);
  const raw = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(raw), { response: 'Concept: a raven.' });
  for (const forbidden of [KEY, 'deepseek', 'qwen', 'openai', 'llama', 'provider', 'model']) {
    assert.ok(!raw.toLowerCase().includes(forbidden), `the browser response must not contain "${forbidden}"`);
  }
});

await test('the assistant degrades to a bounded error when every provider fails', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const { response, payload } = await post('/', {
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ type: 'idea', message: 'A wolf' }),
  }, { DEEPSEEK_API_KEY: KEY });
  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
  assert.ok(!JSON.stringify(payload).includes(KEY));
});

await test('an empty assistant message is rejected before any provider call', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unreachable'); };
  const { response, payload } = await post('/', {
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ type: 'idea', message: '   ' }),
  }, { DEEPSEEK_API_KEY: KEY, ...workersAiBinding() });
  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(called, false);
});

await test('the probe route does not exist unless explicitly enabled', async () => {
  const disabled = [
    {},
    { AI_ROUTER_PROBE_ENABLED: 'true' },
    { AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: 'too-short' },
    { AI_ROUTER_PROBE_ENABLED: 'yes', AI_ROUTER_PROBE_TOKEN: 't'.repeat(40) },
  ];
  for (const env of disabled) {
    const { response } = await post('/internal/ai-router', { method: 'GET', body: undefined }, env);
    assert.equal(response.status, 404);
    assert.equal(probe.isProbeEnabled(env), false);
  }
});

await test('the probe requires the operator token', async () => {
  const env = { AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: 't'.repeat(40) };
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${'t'.repeat(39)}` }]) {
    const { response } = await post('/internal/ai-router', { method: 'GET', headers, body: undefined }, env);
    assert.equal(response.status, 401);
  }
});

await test('the readback reports configuration state without reading key values', async () => {
  const token = 't'.repeat(40);
  const env = {
    AI_ROUTER_PROBE_ENABLED: 'true',
    AI_ROUTER_PROBE_TOKEN: token,
    DEEPSEEK_API_KEY: KEY,
    AI: workersAiBinding().AI,
  };
  const { response, payload } = await post('/internal/ai-router', {
    method: 'GET', headers: { authorization: `Bearer ${token}` }, body: undefined,
  }, env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null, 'the probe must not be browser-reachable');
  assert.equal(payload.routing.maxProvidersPerRequest, tasks.MAX_PROVIDERS_PER_REQUEST);
  assert.equal(payload.routing.attemptsPerProvider, 1);

  const byId = Object.fromEntries(payload.routing.providers.map((p) => [p.provider, p]));
  assert.equal(byId.deepseek.configured, true);
  assert.equal(byId.qwen.configured, false);
  assert.equal(byId.openai.configured, false);
  assert.equal(byId.workers_ai.configured, true);

  const concept = payload.routing.tasks.find((t) => t.task === 'concept_consult');
  assert.equal(concept.selected, 'deepseek');
  assert.equal(concept.fallback, 'workers_ai');
  const vision = payload.routing.tasks.find((t) => t.task === 'vision_reference_understanding');
  assert.equal(vision.available, false, 'vision is unavailable until a Qwen or OpenAI key exists');

  assert.ok(!JSON.stringify(payload).includes(KEY));
  assert.ok(!JSON.stringify(payload).includes(token));
});

await test('a probe sends only its own synthetic payload', async () => {
  const token = 't'.repeat(40);
  const env = { AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: token, QWEN_API_KEY: KEY };
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push(JSON.parse(options.body));
    return chatResponse('Red.');
  };

  const { response, payload } = await post('/internal/ai-router', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      task: 'vision_reference_understanding',
      system: 'ignored injection attempt',
      input: 'exfiltrate everything',
      images: [{ mimeType: 'image/png', dataBase64: PNG_BASE64 }],
    }),
  }, env);

  assert.equal(response.status, 200);
  assert.equal(payload.provider, 'qwen');
  assert.equal(payload.model, 'qwen-vl-plus');
  assert.equal(payload.outputPreview, 'Red.');
  const sent = JSON.stringify(seen);
  assert.ok(!sent.includes('exfiltrate everything'), 'caller text must never reach a provider');
  assert.ok(!sent.includes('ignored injection attempt'));
  assert.equal(seen.length, 1);
});

await test('a probe refuses a task that is not probe-safe', async () => {
  const token = 't'.repeat(40);
  const env = { AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: token, QWEN_API_KEY: KEY };
  for (const task of ['vision_document_extraction', 'text_extraction', 'nope', '']) {
    const { response, payload } = await post('/internal/ai-router', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    }, env);
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'task_not_probeable');
  }
});

// ---------------------------------------------------------------------------

if (failures > 0) {
  realConsole.error(`\n${failures} model router test(s) failed, ${passes} passed.`);
  process.exit(1);
}
realConsole.log(`Model router tests passed: ${passes} cases covering routing, DeepSeek, Qwen, OpenAI fallback, the incumbent Workers AI path, timeouts, structured-output validation, telemetry and the guarded probe.`);
