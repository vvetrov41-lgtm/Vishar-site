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
/**
 * Ceiling for a server-side `AI_TIMEOUT_MS_<TASK>` override. A CRM drain runs
 * at most two jobs of two providers inside a five-minute lease, so even at this
 * ceiling a tick stays well inside its lease.
 */
export const MAX_TIMEOUT_OVERRIDE_MS = 60_000;
export const MAX_OUTPUT_TOKENS = 2_000;
export const MAX_INPUT_CHARS = 12_000;
export const MAX_SYSTEM_CHARS = 20_000;
export const MAX_IMAGES = 2;
// Match the CRM upload contract exactly. The database accepts reference images
// up to 4 MiB, and the Workers AI binding keeps this transfer server-side.
// Keeping one shared ceiling prevents an image the CRM accepted from becoming a
// deterministic terminal failure only when Five Pillars later analyses it.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

const TASKS = Object.freeze({
  // Llama leads: in the 2026-09-25 live eval it was schema-valid and passed
  // every semantic check on all intake fixtures at ~3 s and ~18 Neurons a
  // call, while Qwen needed ~16 s and ~250 Neurons for the same result. Qwen
  // (transport schema) remains the fallback.
  enquiry_intake: {
    capability: 'extraction',
    modality: 'text',
    chain: ['workers_ai', 'qwen'],
    timeoutMs: 30_000,
    maxOutputTokens: 1_400,
    temperature: 0,
    structured: true,
  },
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
  // DeepSeek-first: reasoning is what this tier is for. Qwen backs it up rather
  // than OpenAI, because DeepSeek is gated behind Workers Paid and OpenAI needs
  // a key: pairing the two would leave this task with nothing on an account
  // that has neither. Qwen also reasons and is not plan-gated.
  high_quality_reasoning: {
    capability: 'reasoning',
    modality: 'text',
    chain: ['deepseek', 'qwen'],
    timeoutMs: 30_000,
    maxOutputTokens: 1_200,
    temperature: 0.2,
    structured: false,
  },

  // Derived CRM client state. Llama leads: in the 2026-09-25 live eval it was
  // schema-valid on every fixture and passed 5 of 6 semantic checks (the miss
  // was the waiting side, which the deterministic layer owns) at ~2 s and
  // ~15-30 Neurons a call. Qwen, the previous lead, timed out on a third of
  // calls at ~200-350 Neurons each and showed no measurable quality gain, so it
  // is kept only as the fallback. The output ceiling is the
  // largest here because one call returns a summary, a brief and a
  // recommendation, and a truncated answer fails schema validation and is
  // paid for twice.
  crm_client_state: {
    capability: 'extraction',
    modality: 'text',
    chain: ['workers_ai', 'qwen'],
    timeoutMs: 30_000,
    maxOutputTokens: 1_800,
    temperature: 0,
    structured: true,
  },

  // Phase 3: one short client draft for a draftable next action, generated
  // apart from the client-state analysis so a rejected draft never discards
  // the analysis. Small output ceiling; reply-safety is enforced afterwards.
  // Llama leads, like the rest of the CRM text work (2026-09-25 routing).
  crm_draft_reply: {
    capability: 'drafting',
    modality: 'text',
    chain: ['workers_ai', 'qwen'],
    timeoutMs: 20_000,
    maxOutputTokens: 400,
    temperature: 0.3,
    structured: true,
  },

  // Manual Russian translation of a client's enquiry, on the artist's click
  // only. Never the incumbent Llama 8B: its Russian changed placements and
  // subjects in production (2026-10-04 audit). Qwen 27B leads; the Workers AI
  // tier runs the task's own model (workersAiModel), not the shared text model.
  // Every answer must pass the deterministic fidelity checks in translation.js.
  enquiry_translation: {
    capability: 'translation',
    modality: 'text',
    chain: ['qwen', 'workers_ai'],
    workersAiModel: '@cf/google/gemma-4-26b-a4b-it',
    timeoutMs: 30_000,
    maxOutputTokens: 2_000,
    temperature: 0,
    structured: true,
  },

  // --- declared multimodal capabilities -------------------------------------
  // Structured description of one private client reference image. Separate
  // from `vision_reference_understanding` because that task is unstructured
  // and this one is schema-validated before anything is persisted. Gemma on
  // the shared Workers AI binding is the real fallback: unlike external OpenAI,
  // it is available without an API key and keeps private images on Cloudflare.
  vision_reference_extraction: {
    capability: 'vision',
    modality: 'vision',
    chain: ['qwen', 'workers_ai'],
    timeoutMs: 30_000,
    maxOutputTokens: 900,
    temperature: 0,
    structured: true,
  },
  vision_reference_understanding: {
    capability: 'vision',
    modality: 'vision',
    chain: ['qwen', 'workers_ai'],
    timeoutMs: 30_000,
    maxOutputTokens: 700,
    temperature: 0.2,
    structured: false,
  },
  vision_document_extraction: {
    capability: 'vision',
    modality: 'vision',
    chain: ['qwen', 'workers_ai'],
    timeoutMs: 30_000,
    maxOutputTokens: 800,
    temperature: 0,
    structured: true,
  },
});

export const TASK_NAMES = Object.freeze(Object.keys(TASKS));

/**
 * Models a task may pin on the Workers AI tier, overridable per task with
 * `AI_MODEL_WORKERS_AI_<TASK>`. A closed list: configuration cannot name an
 * arbitrary model, and the 8B Llama is deliberately absent.
 */
export const TASK_WORKERS_AI_MODELS = Object.freeze(new Set([
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/openai/gpt-oss-120b',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8',
]));

/** The Workers AI model a task pins, or null when it uses the shared tier model. */
export function workersAiModelFor(env, taskName, definition) {
  if (!definition?.workersAiModel) return null;
  const raw = env?.[`AI_MODEL_WORKERS_AI_${taskName.toUpperCase()}`];
  const configured = typeof raw === 'string' ? raw.trim() : '';
  return TASK_WORKERS_AI_MODELS.has(configured) ? configured : definition.workersAiModel;
}

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

/** Reads `AI_TIMEOUT_MS_<TASK>`; anything outside [1s, 60s] is ignored. */
export function timeoutOverrideFor(env, taskName) {
  const raw = env?.[`AI_TIMEOUT_MS_${taskName.toUpperCase()}`];
  if (typeof raw !== 'string' || !/^[0-9]{4,5}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= 1_000 && value <= MAX_TIMEOUT_OVERRIDE_MS ? value : null;
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
    timeoutMs: timeoutOverrideFor(env, taskName)
      ?? clampInteger(definition.timeoutMs, 1_000, MAX_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputTokens: clampInteger(definition.maxOutputTokens, 16, MAX_OUTPUT_TOKENS, 512),
    temperature: definition.temperature,
    structured: definition.structured === true,
    workersAiModel: workersAiModelFor(env, taskName, definition),
  });
}

export const __testing = Object.freeze({ TASKS, TASK_NAME_RE, PROVIDER_ID_RE });
