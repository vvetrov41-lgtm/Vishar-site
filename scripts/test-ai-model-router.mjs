#!/usr/bin/env node
//
// Unit tests for the model capability router and its provider tiers.
//
// The DeepSeek, Qwen and Llama tiers all execute on the Cloudflare `AI`
// binding. That is the property most of this file defends: those tiers must
// never reach the network, must never look for an API key, and must still be
// selected by name so the routing layer stays a routing layer.
//
// Also pinned here: OpenAI remains external and entirely optional, the Chinese
// model paths work with no OPENAI_API_KEY, payload and cost ceilings hold,
// telemetry carries operational tokens only, and the guarded probe cannot be
// turned into a relay.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(rootDir, 'workers', rel)).href);

const router = await load('lib/ai/router.js');
const tasks = await load('lib/ai/tasks.js');
const errors = await load('lib/ai/errors.js');
const binding = await load('lib/ai/providers/workers-ai-binding.js');
const deepseek = await load('lib/ai/providers/deepseek.js');
const qwen = await load('lib/ai/providers/qwen.js');
const openai = await load('lib/ai/providers/openai.js');
const llama = await load('lib/ai/providers/workers-ai.js');
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

const DEEPSEEK_MODEL = '@cf/deepseek-ai/deepseek-v4-flash-0731';
const QWEN_MODEL = '@cf/qwen/qwen3.8-27b';
const LLAMA_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

/** A stub `AI` binding that records every call and answers per model id. */
function aiBinding(responder) {
  const calls = [];
  const reply = typeof responder === 'function'
    ? responder
    : () => ({ response: responder ?? 'Concept: a raven.' });
  return {
    calls,
    AI: {
      run: async (model, input) => {
        calls.push({ model, input });
        const answer = await reply(model, calls.length);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

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

/** Any network call at all is a failure for the binding-backed tiers. */
function forbiddenFetch() {
  const impl = async (url) => { throw new Error(`network call must not happen: ${url}`); };
  return impl;
}

function collectingLogger() {
  const lines = [];
  const push = (level) => (event, fields = {}) => lines.push({ level, ...logging.redact({ ...fields, event }) });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

const textInput = { system: SYSTEM, input: INPUT };
const visionInput = { system: SYSTEM, input: INPUT, images: [{ mimeType: 'image/png', dataBase64: PNG_BASE64 }] };

// --- the binding is the transport, not the abstraction ----------------------

await test('DeepSeek, Qwen and Llama are separate tiers that share one binding', () => {
  const env = aiBinding().AI;
  assert.equal(deepseek.configure({ AI: env }, 'text').model, DEEPSEEK_MODEL);
  assert.equal(qwen.configure({ AI: env }, 'vision').model, QWEN_MODEL);
  assert.equal(llama.configure({ AI: env }, 'text').model, LLAMA_MODEL);

  // Distinct ids, so the router still selects a provider by name.
  const ids = [deepseek.id, qwen.id, llama.id, openai.id];
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 3).sort(), ['deepseek', 'qwen', 'workers_ai']);
});

await test('a binding-backed tier is configured by the binding alone, never a key', () => {
  for (const tier of [deepseek, qwen, llama]) {
    const modality = tier.id === 'qwen' ? 'vision' : 'text';
    assert.equal(tier.configure({}, modality), null, `${tier.id} must need the binding`);
    assert.equal(tier.configure({ AI: {} }, modality), null, `${tier.id} must need AI.run`);

    const config = tier.configure({ AI: aiBinding().AI }, modality);
    assert.ok(config, `${tier.id} must configure from the binding`);
    assert.ok(!('apiKey' in config), `${tier.id} must not carry a key`);
    assert.ok(!('url' in config), `${tier.id} must not carry a URL`);
  }
});

await test('no source file references a DeepSeek or DashScope endpoint or key', () => {
  const forbidden = [
    'api.deepseek.com', 'dashscope', 'aliyuncs.com',
    'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'AI_QWEN_BASE_URL',
  ];
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
  });

  for (const file of walk(path.join(rootDir, 'workers'))) {
    const source = readFileSync(file, 'utf8');
    for (const needle of forbidden) {
      assert.ok(!source.includes(needle), `${path.relative(rootDir, file)} still references ${needle}`);
    }
  }
});

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

await test('chain order follows Workers AI cost, not the old vendor assumption', () => {
  // Short, high-volume public replies stay on the cheap Llama tier and escalate.
  for (const name of ['concept_consult', 'aftercare_support']) {
    const chain = tasks.resolveTask({}, name, router.PROVIDER_IDS).chain;
    assert.deepEqual([...chain], ['workers_ai', 'deepseek'], name);
  }
  // Reasoning, structure and long context lead with DeepSeek.
  for (const name of ['text_summarization', 'text_classification', 'text_extraction', 'high_quality_reasoning']) {
    assert.equal(tasks.resolveTask({}, name, router.PROVIDER_IDS).chain[0], 'deepseek', name);
  }
  assert.deepEqual(
    [...tasks.resolveTask({}, 'high_quality_reasoning', router.PROVIDER_IDS).chain],
    ['deepseek', 'qwen'],
  );
  for (const name of ['vision_reference_understanding', 'vision_document_extraction']) {
    assert.equal(tasks.resolveTask({}, name, router.PROVIDER_IDS).chain[0], 'qwen', name);
  }
});

await test('every task keeps a tier that needs neither a key nor a paid plan', () => {
  // OpenAI needs OPENAI_API_KEY. DeepSeek V4 Flash is gated behind Workers Paid
  // or prepaid AI Gateway credits, which a production probe confirmed this
  // account does not have. A chain built only from those two can strand a task.
  const needsAKey = new Set(['openai']);
  const needsAPaidPlan = new Set(['deepseek']);

  for (const name of tasks.TASK_NAMES) {
    const plan = tasks.resolveTask({}, name, router.PROVIDER_IDS);
    const alwaysAvailable = plan.chain.filter((id) => !needsAKey.has(id) && !needsAPaidPlan.has(id));
    assert.ok(
      alwaysAvailable.length >= 1,
      `${name} routes only to gated tiers (${plan.chain.join(', ')}) and would strand`,
    );
  }
});

await test('server-side route overrides apply, and invalid ones are ignored', () => {
  const overridden = tasks.resolveTask(
    { AI_ROUTE_CONCEPT_CONSULT: 'deepseek, workers_ai' }, 'concept_consult', router.PROVIDER_IDS);
  assert.deepEqual([...overridden.chain], ['deepseek', 'workers_ai']);
  assert.equal(overridden.routeSource, 'env');

  for (const bad of ['', 'not_a_provider', 'deepseek,deepseek', 'deepseek,openai,workers_ai', '../etc']) {
    const plan = tasks.resolveTask({ AI_ROUTE_CONCEPT_CONSULT: bad }, 'concept_consult', router.PROVIDER_IDS);
    assert.deepEqual([...plan.chain], ['workers_ai', 'deepseek'], `override "${bad}" must be ignored`);
    assert.equal(plan.routeSource, 'default');
  }
});

await test('an unknown task never reaches a provider', async () => {
  const stub = aiBinding();
  const result = await router.runModelTask({ AI: stub.AI }, 'no_such_task', textInput, { fetchImpl: forbiddenFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'task_unknown');
  assert.equal(stub.calls.length, 0);
});

// --- DeepSeek via env.AI ----------------------------------------------------

await test('DeepSeek runs on the binding with the Cloudflare model id and no network', async () => {
  const stub = aiBinding((model) => (model === DEEPSEEK_MODEL ? { response: '  Considered answer.  ' } : null));
  const result = await router.runModelTask(
    { AI: stub.AI }, 'high_quality_reasoning', textInput, { fetchImpl: forbiddenFetch() });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, DEEPSEEK_MODEL);
  assert.equal(result.text, 'Considered answer.');
  assert.equal(result.fallbackUsed, false);

  assert.equal(stub.calls.length, 1);
  const [call] = stub.calls;
  assert.equal(call.model, DEEPSEEK_MODEL);
  assert.deepEqual(call.input.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(call.input.messages[1].content, INPUT);
  assert.equal(
    call.input.max_tokens,
    tasks.resolveTask({}, 'high_quality_reasoning', router.PROVIDER_IDS).maxOutputTokens,
  );
});

await test('the DeepSeek model id is server-configurable but must be a Cloudflare id', () => {
  const AI = aiBinding().AI;
  assert.equal(
    deepseek.configure({ AI, AI_MODEL_DEEPSEEK_TEXT: '@cf/deepseek-ai/deepseek-v4-pro-0813' }, 'text').model,
    '@cf/deepseek-ai/deepseek-v4-pro-0813',
  );
  for (const bad of ['deepseek-chat', 'https://api.deepseek.com/v1', '@cf/', 'x'.repeat(200)]) {
    assert.equal(deepseek.configure({ AI, AI_MODEL_DEEPSEEK_TEXT: bad }, 'text').model, DEEPSEEK_MODEL, bad);
  }
  assert.equal(deepseek.configure({ AI }, 'vision'), null, 'DeepSeek must never take image work');
});

// --- Qwen vision via env.AI -------------------------------------------------

await test('Qwen vision runs on the binding and carries the image as a data URI part', async () => {
  const stub = aiBinding((model) => (model === QWEN_MODEL ? { response: 'Red.' } : null));
  const result = await router.runModelTask(
    { AI: stub.AI }, 'vision_reference_understanding', visionInput, { fetchImpl: forbiddenFetch() });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'qwen');
  assert.equal(result.model, QWEN_MODEL);
  assert.equal(result.text, 'Red.');

  const parts = stub.calls[0].input.messages[1].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[0].text, INPUT);
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${PNG_BASE64}`);
});

await test('Qwen vision needs no OpenAI key', async () => {
  const stub = aiBinding(() => ({ response: 'Red.' }));
  const result = await router.runModelTask(
    { AI: stub.AI }, 'vision_reference_understanding', visionInput, { fetchImpl: forbiddenFetch() });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'qwen');
});

await test('the Qwen model id is server-configurable but must be a Cloudflare id', () => {
  const AI = aiBinding().AI;
  assert.equal(qwen.configure({ AI, AI_MODEL_QWEN_VISION: '@cf/qwen/qwen3.8-27b' }, 'vision').model, QWEN_MODEL);
  for (const bad of ['qwen-vl-plus', 'https://dashscope-intl.aliyuncs.com/x', '']) {
    assert.equal(qwen.configure({ AI, AI_MODEL_QWEN_VISION: bad }, 'vision').model, QWEN_MODEL, bad);
  }
});

// --- request bounds ---------------------------------------------------------

await test('image payloads are bounded before the binding is called', async () => {
  const stub = aiBinding();
  const env = { AI: stub.AI };
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
    const result = await router.runModelTask(env, 'vision_reference_understanding', input, { fetchImpl: forbiddenFetch() });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'request_invalid');
  }
  assert.equal(stub.calls.length, 0, 'a rejected request must never be billed');
});

await test('a text task refuses images rather than silently dropping them', async () => {
  const stub = aiBinding();
  const result = await router.runModelTask({ AI: stub.AI }, 'concept_consult', visionInput, { fetchImpl: forbiddenFetch() });
  assert.equal(result.errorCode, 'request_invalid');
  assert.equal(stub.calls.length, 0);
});

// --- fallback ---------------------------------------------------------------

await test('a failing DeepSeek call falls through to Llama on the same binding', async () => {
  const stub = aiBinding((model) => (model === DEEPSEEK_MODEL
    ? new Error('model not available on this plan')
    : { response: 'Summary.' }));

  const result = await router.runModelTask(
    { AI: stub.AI }, 'text_summarization', textInput, { fetchImpl: forbiddenFetch() });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'workers_ai');
  assert.equal(result.model, LLAMA_MODEL);
  assert.equal(result.fallbackUsed, true);
  assert.equal(stub.calls.length, 2, 'one attempt per tier, no retry loop');
  assert.deepEqual(result.attempts.map((a) => `${a.provider}:${a.outcome}`), ['deepseek:failed', 'workers_ai:succeeded']);
  // A binding exception must never leak the provider's own wording.
  assert.equal(result.attempts[0].errorCode, 'provider_unavailable');
});

await test('the live public chain still lands on Llama first', async () => {
  const stub = aiBinding(() => ({ response: 'Concept: a raven.' }));
  const result = await router.runModelTask(
    { AI: stub.AI }, 'concept_consult', textInput, { fetchImpl: forbiddenFetch() });

  assert.equal(result.provider, 'workers_ai');
  assert.equal(result.model, LLAMA_MODEL);
  assert.equal(result.fallbackUsed, false);
  assert.equal(stub.calls.length, 1, 'the cheap tier answers without touching DeepSeek');
});

await test('Qwen failure reaches OpenAI when, and only when, a key exists', async () => {
  const failingQwen = () => new Error('vision unavailable');

  const withoutKey = aiBinding(failingQwen);
  const noFallback = await router.runModelTask(
    { AI: withoutKey.AI }, 'vision_reference_understanding', visionInput, { fetchImpl: forbiddenFetch() });
  assert.equal(noFallback.ok, false);
  assert.equal(noFallback.errorCode, 'all_providers_failed');
  assert.equal(noFallback.attempts.length, 1, 'an unconfigured tier is skipped, not attempted');

  const withKey = aiBinding(failingQwen);
  const fetchImpl = recordingFetch(() => chatResponse('A red square.'));
  const recovered = await router.runModelTask(
    { AI: withKey.AI, OPENAI_API_KEY: KEY }, 'vision_reference_understanding', visionInput, { fetchImpl });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.provider, 'openai');
  assert.equal(recovered.fallbackUsed, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, openai.__testing.DEFAULT_URL);
});

await test('without the binding nothing is attempted', async () => {
  for (const name of ['concept_consult', 'text_summarization', 'vision_reference_understanding']) {
    const result = await router.runModelTask({}, name, name.startsWith('vision') ? visionInput : textInput,
      { fetchImpl: forbiddenFetch() });
    assert.equal(result.ok, false, name);
    assert.equal(result.errorCode, 'no_provider_configured', name);
  }
});

await test('a chain that fails everywhere fails closed without throwing', async () => {
  const stub = aiBinding(() => new Error('down'));
  const result = await router.runModelTask(
    { AI: stub.AI }, 'text_summarization', textInput, { fetchImpl: forbiddenFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'all_providers_failed');
  assert.equal(stub.calls.length, 2, 'the two-provider cap holds even when every tier fails');
});

await test('a hung binding times out and the chain moves on once', async () => {
  const calls = [];
  const AI = {
    run: async (model) => {
      calls.push(model);
      if (model === DEEPSEEK_MODEL) return new Promise(() => {});
      return { response: 'Recovered.' };
    },
  };
  const started = Date.now();
  const result = await router.runModelTask({ AI }, 'text_summarization', textInput, { fetchImpl: forbiddenFetch() });
  assert.ok(Date.now() - started < 25_000, 'the timeout must bound the request');
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].errorCode, 'provider_timeout');
  assert.equal(result.provider, 'workers_ai');
});

// --- response normalisation -------------------------------------------------

await test('the binding transport normalises every documented answer shape', () => {
  assert.deepEqual(binding.normalizeBindingResponse({ response: ' hi ' }), { text: 'hi', finishReason: 'stop' });
  assert.deepEqual(binding.normalizeBindingResponse('  plain  '), { text: 'plain', finishReason: 'stop' });
  assert.deepEqual(
    binding.normalizeBindingResponse({ choices: [{ message: { content: 'chat' }, finish_reason: 'length' }] }),
    { text: 'chat', finishReason: 'length' },
  );
  assert.deepEqual(
    binding.normalizeBindingResponse({ choices: [{ message: { content: [{ text: 'part ' }, { text: 'two' }] } }] }),
    { text: 'part two', finishReason: 'stop' },
  );
});

await test('an empty or malformed binding answer is rejected, with the two told apart', () => {
  for (const empty of [{ response: '   ' }, { choices: [] }, { result: '' }]) {
    assert.throws(() => binding.normalizeBindingResponse(empty), /provider_empty_response/);
  }
  for (const malformed of [null, undefined, 42, ['a'], { unexpected: true }]) {
    assert.throws(() => binding.normalizeBindingResponse(malformed), /provider_malformed_response/);
  }
});

await test('a malformed binding answer fails the attempt rather than reaching a caller', async () => {
  const stub = aiBinding(() => ({ unexpected: true }));
  const result = await router.runModelTask(
    { AI: stub.AI }, 'text_summarization', textInput, { fetchImpl: forbiddenFetch() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map((a) => a.errorCode), ['provider_malformed_response', 'provider_malformed_response']);
});

// --- structured output ------------------------------------------------------

await test('unparseable structured output is a failure, and a fenced object is not', async () => {
  const bad = aiBinding(() => ({ response: 'Sure! Here is the answer.' }));
  const failed = await router.runModelTask(
    { AI: bad.AI }, 'text_classification', textInput,
    { fetchImpl: forbiddenFetch(), requiredKeys: ['label'] });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.attempts.map((a) => a.errorCode), ['output_invalid', 'output_invalid']);

  const mixed = aiBinding((model) => (model === DEEPSEEK_MODEL
    ? { response: 'not json' }
    : { response: '```json\n{"label":"cover_up"}\n```' }));
  const recovered = await router.runModelTask(
    { AI: mixed.AI }, 'text_classification', textInput,
    { fetchImpl: forbiddenFetch(), requiredKeys: ['label'] });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.provider, 'workers_ai');
  assert.deepEqual(recovered.json, { label: 'cover_up' });

  const missingKey = aiBinding(() => ({ response: '{"other":"value"}' }));
  const rejected = await router.runModelTask(
    { AI: missingKey.AI }, 'text_classification', textInput,
    { fetchImpl: forbiddenFetch(), requiredKeys: ['label'] });
  assert.equal(rejected.ok, false);
});

await test('every provider error code is in the declared taxonomy', () => {
  assert.equal(errors.providerErrorCodeForStatus(429), 'provider_rate_limited');
  assert.equal(errors.providerErrorCodeForStatus(503), 'provider_unavailable');
  assert.equal(errors.providerErrorCodeForStatus(404), 'provider_http_error');
  assert.equal(new errors.ProviderError('nonsense').code, 'provider_unavailable');
  assert.ok(errors.PROVIDER_ERROR_CODES.includes('provider_malformed_response'));
});

// --- telemetry --------------------------------------------------------------

await test('telemetry identifies the tier and model without carrying content', async () => {
  const logger = collectingLogger();
  const stub = aiBinding((model) => (model === DEEPSEEK_MODEL
    ? new Error('paid plan required')
    : { response: 'A summary mentioning a raven.' }));

  const result = await router.runModelTask(
    { AI: stub.AI }, 'text_summarization', textInput, { fetchImpl: forbiddenFetch(), logger });

  const completed = logger.lines.find((line) => line.event === 'ai.router.completed');
  assert.ok(completed);
  assert.equal(completed.task, 'text_summarization');
  assert.equal(completed.provider, 'workers_ai');
  assert.equal(completed.model, 'cf-meta-llama-3.1-8b-instruct-fast');
  assert.equal(completed.fallbackUsed, true);
  assert.equal(completed.providerAttempts, 2);
  assert.equal(completed.outputChars, result.text.length);

  const attempt = logger.lines.find((line) => line.event === 'ai.router.attempt' && line.provider === 'deepseek');
  assert.equal(attempt.model, 'cf-deepseek-ai-deepseek-v4-flash-0731');
  assert.equal(attempt.errorCode, 'provider_unavailable');

  const serialized = JSON.stringify(logger.lines);
  for (const forbidden of [SYSTEM, INPUT, 'raven', 'paid plan required']) {
    assert.ok(!serialized.includes(forbidden), `telemetry must not contain "${forbidden}"`);
  }
});

await test('routing telemetry survives the external observability sanitizer', () => {
  const payload = observability.sanitizeOperationalEvent({
    event: 'ai.router.completed',
    operation: 'vision_reference_understanding',
    provider: 'qwen',
    model: router.modelToken(QWEN_MODEL),
    fallbackUsed: 'no',
    outcome: 'succeeded',
    durationMs: 120,
  });
  assert.deepEqual(payload, {
    event: 'ai.router.completed',
    operation: 'vision_reference_understanding',
    provider: 'qwen',
    model: 'cf-qwen-qwen3.8-27b',
    fallbackUsed: 'no',
    outcome: 'succeeded',
    durationMs: 120,
  });
  assert.deepEqual(
    observability.sanitizeOperationalEvent({ event: 'ai.router.completed', model: 'a wolf in moonlight' }),
    { event: 'ai.router.completed' },
  );
});

// --- browser boundary and the guarded probe ---------------------------------

const ENDPOINT = 'https://tattooai.vvetrov41.workers.dev/';
const ORIGIN = 'https://vishartattoo.com';
const ctx = { waitUntil: () => {} };

async function post(pathname, options = {}, env = {}) {
  const request = new Request(`${ENDPOINT.replace(/\/$/, '')}${pathname}`, {
    method: options.method ?? 'POST',
    headers: options.headers ?? { 'content-type': 'application/json' },
    body: options.body,
  });
  const response = await worker.fetch(request, env, ctx);
  return { response, payload: await response.json().catch(() => ({})) };
}

await test('the public assistant answers from the binding and exposes nothing about it', async () => {
  const stub = aiBinding(() => ({ response: 'Concept: a raven.' }));
  globalThis.fetch = async () => { throw new Error('the public assistant must not use the network'); };

  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ type: 'idea', message: 'A wolf' }),
  });
  const response = await worker.fetch(request, { AI: stub.AI, OPENAI_API_KEY: KEY }, ctx);
  const raw = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(raw), { response: 'Concept: a raven.' });
  for (const forbidden of [KEY, 'deepseek', 'qwen', 'openai', 'llama', '@cf/', 'provider', 'model']) {
    assert.ok(!raw.toLowerCase().includes(forbidden.toLowerCase()), `the browser response must not contain "${forbidden}"`);
  }
});

await test('the assistant degrades to a bounded error when every tier fails', async () => {
  const stub = aiBinding(() => new Error('down'));
  const { response, payload } = await post('/', {
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ type: 'idea', message: 'A wolf' }),
  }, { AI: stub.AI });
  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
});

await test('an empty assistant message is rejected before any billed call', async () => {
  const stub = aiBinding();
  const { response, payload } = await post('/', {
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ type: 'idea', message: '   ' }),
  }, { AI: stub.AI });
  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(stub.calls.length, 0);
});

await test('the probe route stays closed until a token secret exists', async () => {
  const AI = aiBinding().AI;
  const closed = [
    { AI },
    { AI, AI_ROUTER_PROBE_ENABLED: 'true' },
    { AI, AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: 'too-short' },
    { AI, AI_ROUTER_PROBE_ENABLED: 'false', AI_ROUTER_PROBE_TOKEN: 't'.repeat(40) },
  ];
  for (const env of closed) {
    const { response } = await post('/internal/ai-router', { method: 'GET', body: undefined }, env);
    assert.equal(response.status, 404);
    assert.equal(probe.isProbeEnabled(env), false);
  }
});

await test('the probe requires the operator token', async () => {
  const env = { AI: aiBinding().AI, AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: 't'.repeat(40) };
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${'t'.repeat(39)}` }]) {
    const { response } = await post('/internal/ai-router', { method: 'GET', headers, body: undefined }, env);
    assert.equal(response.status, 401);
  }
});

await test('the readback reports every tier as available from the binding alone', async () => {
  const token = 't'.repeat(40);
  const env = {
    AI: aiBinding().AI,
    AI_ROUTER_PROBE_ENABLED: 'true',
    AI_ROUTER_PROBE_TOKEN: token,
  };
  const { response, payload } = await post('/internal/ai-router', {
    method: 'GET', headers: { authorization: `Bearer ${token}` }, body: undefined,
  }, env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null, 'the probe must not be browser-reachable');

  const byId = Object.fromEntries(payload.routing.providers.map((p) => [p.provider, p]));
  assert.equal(byId.deepseek.configured, true, 'DeepSeek needs no key now');
  assert.equal(byId.qwen.configured, true, 'Qwen needs no key now');
  assert.equal(byId.workers_ai.configured, true);
  assert.equal(byId.openai.configured, false, 'OpenAI stays optional and external');

  const vision = payload.routing.tasks.find((t) => t.task === 'vision_reference_understanding');
  assert.equal(vision.selected, 'qwen');
  assert.equal(vision.available, true, 'vision is available with no external key at all');
  const reasoning = payload.routing.tasks.find((t) => t.task === 'high_quality_reasoning');
  assert.equal(reasoning.selected, 'deepseek');
  assert.equal(reasoning.fallback, 'qwen', 'reasoning must keep a tier that needs no key');

  assert.ok(!JSON.stringify(payload).includes(token));
});

await test('a probe sends only its own synthetic payload', async () => {
  const token = 't'.repeat(40);
  const stub = aiBinding(() => ({ response: 'Red.' }));
  const env = { AI: stub.AI, AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: token };

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
  assert.equal(payload.model, QWEN_MODEL);
  assert.equal(payload.outputPreview, 'Red.');
  const sent = JSON.stringify(stub.calls);
  assert.ok(!sent.includes('exfiltrate everything'), 'caller text must never reach a model');
  assert.ok(!sent.includes('ignored injection attempt'));
  assert.equal(stub.calls.length, 1);
});

await test('the probe can exercise the DeepSeek tier specifically', async () => {
  const token = 't'.repeat(40);
  const stub = aiBinding((model) => (model === DEEPSEEK_MODEL ? { response: 'ROUTED' } : null));
  const env = { AI: stub.AI, AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: token };

  const { response, payload } = await post('/internal/ai-router', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'high_quality_reasoning' }),
  }, env);

  assert.equal(response.status, 200);
  assert.equal(payload.provider, 'deepseek');
  assert.equal(payload.model, DEEPSEEK_MODEL);
  assert.equal(payload.outputPreview, 'ROUTED');
});

await test('a probe refuses a task that is not probe-safe', async () => {
  const token = 't'.repeat(40);
  const env = { AI: aiBinding().AI, AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: token };
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
realConsole.log(`Model router tests passed: ${passes} cases covering the Cloudflare-hosted DeepSeek, Qwen and Llama tiers, the optional external OpenAI tier, routing, fallback, payload bounds, response normalisation, telemetry and the guarded probe.`);
