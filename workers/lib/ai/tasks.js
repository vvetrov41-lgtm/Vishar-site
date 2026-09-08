// Capability registry for model work.
//
// CRM and public-site code asks for a TASK ("summarise this", "understand this
// reference image"). It never names a provider, a model or an API. This file is
// the only place that maps a task to an ordered provider preference, and every
// entry here is also a cost decision: output ceiling, timeout and how many
// providers may ever be tried for one request.
//
// Two of these tasks carry live public traffic today (`concept_consult` and
// `aftercare_support`). The rest are declared capabilities with adapters behind
// them: they are reachable through the router and the guarded probe, and are
// wired to a caller when a CRM surface actually needs them.
//
// Chain order is a cost decision, and on Workers AI the cheap tier is Llama 8B,
// not DeepSeek: DeepSeek V4 Flash costs $0.44/$1.32 per M against Llama's
// $0.15-ish, and it additionally requires the Workers Paid plan. So the two
// short, high-volume public assistant replies stay on Llama and escalate to
// DeepSeek only if that fails, while the tasks that actually benefit from
// reasoning, structure or a long context lead with DeepSeek. Every one of these
// orders is overridable server-side via `AI_ROUTE_<TASK>`.

/** A request may never touch more than this many providers, whatever a route says. */
export const MAX_PROVIDERS_PER_REQUEST = 2;

/** One attempt per provider. Retrying inside a chain multiplies spend for little gain. */
export const ATTEMPTS_PER_PROVIDER = 1;

export const MAX_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_TOKENS = 2_000;
export const MAX_INPUT_CHARS = 12_000;
export const MAX_SYSTEM_CHARS = 20_000;
export const MAX_IMAGES = 2;
export const MAX_IMAGE_BYTES = 1_500_000;
export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

const TASKS = Object.freeze({
  // --- live public-site traffic ---------------------------------------------
  concept_consult: {
    capability: 'drafting',
    modality: 'text',
    chain: ['workers_ai', 'deepseek'],
    timeoutMs: 15_000,
    maxOutputTokens: 500,
    temperature: 0.4,
    structured: false,
  },
  aftercare_support: {
    capability: 'drafting',
    modality: 'text',
    chain: ['workers_ai', 'deepseek'],
    timeoutMs: 15_000,
    maxOutputTokens: 600,
    temperature: 0.2,
    structured: false,
  },

  // --- declared text capabilities -------------------------------------------
  text_extraction: {
    capability: 'extraction',
    modality: 'text',
    chain: ['deepseek', 'workers_ai'],
    timeoutMs: 20_000,
    maxOutputTokens: 800,
    temperature: 0,
    structured: true,
  },
  text_classification: {
    capability: 'classification',
    modality: 'text',
    chain: ['deepseek', 'workers_ai'],
    timeoutMs: 15_000,
    maxOutputTokens: 200,
    temperature: 0,
    structured: true,
  },
  text_summarization: {
    capability: 'summarization',
    modality: 'text',
    chain: ['deepseek', 'workers_ai'],
    timeoutMs: 20_000,
    maxOutputTokens: 600,
    temperature: 0.2,
    structured: false,
  },
  // DeepSeek-first: reasoning is what this tier is for. OpenAI stays as an
  // optional external second opinion and is simply skipped when no key exists.
  high_quality_reasoning: {
    capability: 'reasoning',
    modality: 'text',
    chain: ['deepseek', 'openai'],
    timeoutMs: 30_000,
    maxOutputTokens: 1_200,
    temperature: 0.2,
    structured: false,
  },

  // --- declared multimodal capabilities -------------------------------------
  vision_reference_understanding: {
    capability: 'vision',
    modality: 'vision',
    chain: ['qwen', 'openai'],
    timeoutMs: 30_000,
    maxOutputTokens: 700,
    temperature: 0.2,
    structured: false,
  },
  vision_document_extraction: {
    capability: 'vision',
    modality: 'vision',
    chain: ['qwen', 'openai'],
    timeoutMs: 30_000,
    maxOutputTokens: 800,
    temperature: 0,
    structured: true,
  },
});

export const TASK_NAMES = Object.freeze(Object.keys(TASKS));

const TASK_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const PROVIDER_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;

function clampInteger(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Reads `AI_ROUTE_<TASK>` as an ordered provider list. Server-side configuration
 * can reorder or shorten a chain without a code change, but it cannot invent a
 * provider id, exceed the per-request provider cap, or empty a chain — a route
 * that fails those checks is ignored and the compiled default stands.
 */
export function routeOverrideFor(env, taskName, knownProviderIds) {
  const raw = env?.[`AI_ROUTE_${taskName.toUpperCase()}`];
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const requested = raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!requested.length || requested.length > MAX_PROVIDERS_PER_REQUEST) return null;
  if (new Set(requested).size !== requested.length) return null;
  if (!requested.every((id) => PROVIDER_ID_RE.test(id) && knownProviderIds.has(id))) return null;

  return requested;
}

/**
 * Resolves one task to its effective plan. `knownProviderIds` is supplied by the
 * router so this module never imports an adapter and stays a pure description.
 */
export function resolveTask(env, taskName, knownProviderIds = new Set()) {
  if (typeof taskName !== 'string' || !TASK_NAME_RE.test(taskName)) return null;
  const definition = TASKS[taskName];
  if (!definition) return null;

  const override = routeOverrideFor(env, taskName, knownProviderIds);
  const chain = (override ?? definition.chain).slice(0, MAX_PROVIDERS_PER_REQUEST);

  return Object.freeze({
    task: taskName,
    capability: definition.capability,
    modality: definition.modality,
    chain: Object.freeze(chain),
    routeSource: override ? 'env' : 'default',
    timeoutMs: clampInteger(definition.timeoutMs, 1_000, MAX_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputTokens: clampInteger(definition.maxOutputTokens, 16, MAX_OUTPUT_TOKENS, 512),
    temperature: definition.temperature,
    structured: definition.structured === true,
  });
}

export const __testing = Object.freeze({ TASKS, TASK_NAME_RE, PROVIDER_ID_RE });
