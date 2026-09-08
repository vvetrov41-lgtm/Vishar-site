// Guarded model-routing readback and probe.
//
// Two operator questions have to be answerable against the deployed Worker
// rather than against the repository: which providers is production actually
// holding credentials for, and does a request really reach them. This route
// answers both without any customer data.
//
//   GET  -> configuration readback. Which providers are configured (boolean
//           only, never a key value) and how each task currently routes.
//   POST -> one live request per call, built from a FIXED synthetic prompt and,
//           for vision, a FIXED 16x16 generated PNG. No caller-supplied content
//           reaches a provider, so a probe can never become an open relay to a
//           paid API or leak a client's reference image.
//
// Off unless `AI_ROUTER_PROBE_ENABLED` is exactly "true" AND a probe token of
// at least 32 characters is configured. While off the path does not exist:
// it answers 404, the same as any unknown path, and reveals nothing.
//
// In production the flag is set in wrangler.toml, which marks the build as
// willing to serve a probe; the operative gate is the token, and no token
// exists in steady state. The production probe workflow provisions an ephemeral
// one, uses it, and deletes it in the same run, so the window is minutes long
// and the value never leaves the runner.
//
// No CORS headers are emitted. A browser cannot reach this from the site.

import { describeRouting, runModelTask } from '../lib/ai/router.js';
import { ENQUIRY_AI_SYSTEM, validateEnquiryAnalysis } from '../lib/ai/enquiry-schema.js';
import { createLogger, newRequestId } from '../lib/logging.js';

const PATH = '/internal/ai-router';
const MIN_TOKEN_LENGTH = 32;
const MAX_PREVIEW_CHARS = 160;

// A 16x16 solid-colour PNG generated for this repository. Not a client image
// and not a photograph: it exists only to prove that an image payload survives
// the adapter, the provider and the response normaliser.
const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4o6FBEmIY1TCqYfhqAAAyBCwQhCQ/2gAAAABJRU5ErkJggg==';

const PROBES = Object.freeze({
  enquiry_intake: {
    system: ENQUIRY_AI_SYSTEM,
    input: JSON.stringify({ untrusted_client_data: {
      client: { full_name: 'Synthetic Probe', email: 'probe@example.invalid' },
      enquiry: { idea: 'A black and grey Neptune tattoo on the outer forearm, about twenty centimetres.' },
      artist: { display_name: 'Studio artist' }, reference_images_present: false,
    } }),
    images: [],
    requiredKeys: ['fields', 'summary', 'missing_information', 'draft_reply'],
  },
  concept_consult: {
    system: 'You are a routing probe. Reply with exactly the word: ROUTED.',
    input: 'Reply with the single word ROUTED.',
    images: [],
  },
  aftercare_support: {
    system: 'You are a routing probe. Reply with exactly the word: ROUTED.',
    input: 'Reply with the single word ROUTED.',
    images: [],
  },
  text_summarization: {
    system: 'You are a routing probe. Reply with exactly the word: ROUTED.',
    input: 'Reply with the single word ROUTED.',
    images: [],
  },
  text_classification: {
    system: 'You are a routing probe. Reply with compact JSON only: {"status":"routed"}.',
    input: 'Return the JSON object {"status":"routed"}.',
    images: [],
    requiredKeys: ['status'],
  },
  high_quality_reasoning: {
    system: 'You are a routing probe. Reply with exactly the word: ROUTED.',
    input: 'Reply with the single word ROUTED.',
    images: [],
  },
  vision_reference_understanding: {
    system: 'You are a routing probe. Answer in one word.',
    input: 'What is the dominant colour of this image? Answer in one word.',
    images: [{ mimeType: 'image/png', dataBase64: PROBE_IMAGE_BASE64 }],
  },
});

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function probeToken(env) {
  const token = typeof env?.AI_ROUTER_PROBE_TOKEN === 'string' ? env.AI_ROUTER_PROBE_TOKEN.trim() : '';
  return token.length >= MIN_TOKEN_LENGTH ? token : '';
}

export function isProbeEnabled(env) {
  return env?.AI_ROUTER_PROBE_ENABLED === 'true' && probeToken(env) !== '';
}

export function isAiRouterProbePath(request) {
  try {
    return new URL(request.url).pathname.replace(/\/+$/, '') === PATH;
  } catch {
    return false;
  }
}

/** Length-independent comparison, so a wrong token leaks no timing signal. */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function authorized(request, env) {
  const expected = probeToken(env);
  if (!expected) return false;
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer (\S{1,512})$/.exec(header);
  return match ? tokenMatches(match[1], expected) : false;
}

export async function handleAiRouterProbeRequest(request, env, { fetchImpl = fetch } = {}) {
  if (!isProbeEnabled(env)) return json(404, { ok: false, error: 'not_found' });
  if (!authorized(request, env)) return json(401, { ok: false, error: 'unauthorized' });

  if (request.method === 'GET') {
    return json(200, { ok: true, routing: describeRouting(env) });
  }
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const body = await request.json().catch(() => null);
  const task = typeof body?.task === 'string' ? body.task : '';
  const probe = Object.prototype.hasOwnProperty.call(PROBES, task) ? PROBES[task] : null;
  if (!probe) return json(400, { ok: false, error: 'task_not_probeable' });

  const result = await runModelTask(
    env,
    task,
    { system: probe.system, input: probe.input, images: probe.images },
    { fetchImpl, logger: createLogger(newRequestId()), requiredKeys: probe.requiredKeys ?? [] },
  );

  // Attempts are already bounded operational tokens. The preview is the model's
  // answer to a fixed synthetic prompt, so echoing a short slice proves real
  // inference without exposing anything about a person.
  const schemaValid = task === 'enquiry_intake' ? Boolean(result.ok && validateEnquiryAnalysis(result.json)) : null;
  const ok = result.ok && schemaValid !== false;
  return json(ok ? 200 : 502, {
    ok,
    ...(schemaValid !== null ? { schemaValid } : {}),
    task: result.task,
    capability: result.capability ?? null,
    provider: result.provider ?? null,
    model: result.model ?? null,
    fallbackUsed: result.fallbackUsed ?? false,
    errorCode: schemaValid === false && result.ok ? 'output_invalid' : result.errorCode ?? null,
    durationMs: result.durationMs,
    attempts: result.attempts,
    outputChars: result.ok ? result.text.length : 0,
    outputPreview: task === 'enquiry_intake' ? null : result.ok ? result.text.slice(0, MAX_PREVIEW_CHARS) : null,
  });
}

export const __testing = Object.freeze({ PATH, PROBES, MIN_TOKEN_LENGTH, tokenMatches });
