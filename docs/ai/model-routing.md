# Model routing

## What this is

Every model call in the system goes through one capability router. Callers name
a **task**; the router picks the tier, enforces the cost ceiling, normalises the
answer and emits sanitized telemetry.

Three of the four tiers — DeepSeek, Qwen and Llama — execute on the account's
existing Cloudflare `AI` binding. There is no DeepSeek account, no Alibaba
account, no vendor endpoint and no vendor API key anywhere in the system. The
binding is the transport; it is deliberately not the abstraction, so each tier
keeps its own adapter, its own model id and its own configuration keys, and
moving one back to a vendor API later would touch that adapter alone.

The fourth tier, OpenAI, is external and entirely optional. No chain depends on
it: a test asserts that every task still resolves with `OPENAI_API_KEY` absent.

## History

Before this router there was exactly one model call: `workers/tattooai.js`
invoked the `AI` binding with `@cf/meta/llama-3.1-8b-instruct` for the two
public assistants. There was never an outbound OpenAI path — the `gpt-actions`
Workers are the opposite direction, an OpenAPI surface a Custom GPT calls *into*.

That single call was also broken. Cloudflare retired
`@cf/meta/llama-3.1-8b-instruct` on 2026-05-30, so `env.AI.run` threw on every
request and both live assistants answered HTTP 500 (`error code: 1101`), verified
against the deployed Worker on 2026-09-08. The Llama tier now calls
`@cf/meta/llama-3.1-8b-instruct-fast`, which Cloudflare's deprecation notice
names as a variant that stays active.

The DeepSeek and Qwen tiers were first built against the vendors' own HTTPS APIs
and moved onto the `AI` binding once both models became Cloudflare-hosted.

## How a caller asks for work

Callers name a **task**, never a provider:

```js
import { runModelTask } from './lib/ai/router.js';

const result = await runModelTask(env, 'text_summarization',
  { system: SYSTEM_PROMPT, input: text },
  { fetchImpl: fetch, logger });

if (result.ok) use(result.text);
```

`result` is always an object, including on total failure (`{ok: false, errorCode}`).
The router does not throw into a request path.

## Tiers

| Tier | Runs on | Model | Notes |
|---|---|---|---|
| `workers_ai` | `env.AI` | `@cf/meta/llama-3.1-8b-instruct-fast` | the cheap, high-volume tier and the safety net |
| `deepseek` | `env.AI` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | reasoning, structure, 1.3M context. **Requires Workers Paid** or prepaid AI Gateway credits |
| `qwen` | `env.AI` | `@cf/qwen/qwen3.8-27b` | vision, image-text-to-text, 262K context |
| `openai` | HTTPS | `gpt-4o-mini` | optional external second opinion; skipped when unconfigured |

## Tasks and where they route

| Task | Modality | Default chain | Live today |
|---|---|---|---|
| `concept_consult` | text | Llama → DeepSeek | yes, `/ai-tools/` idea assistant |
| `aftercare_support` | text | Llama → DeepSeek | yes, `/aftercare/` assistant |
| `text_summarization` | text | DeepSeek → Llama | declared |
| `text_classification` | text, JSON | DeepSeek → Llama | declared |
| `text_extraction` | text, JSON | DeepSeek → Llama | declared |
| `high_quality_reasoning` | text | DeepSeek → OpenAI | declared |
| `vision_reference_understanding` | vision | Qwen → OpenAI | declared |
| `vision_document_extraction` | vision, JSON | Qwen → OpenAI | declared |

### Why Llama leads the public assistants

The usual "DeepSeek is the cheap tier" assumption inverts on Workers AI.
DeepSeek V4 Flash is $0.44/M in and $1.32/M out; Llama 3.1 8B is roughly a third
of that. The two public assistants are short, high-volume replies that do not
need a frontier model, so they stay on Llama and escalate to DeepSeek only if it
fails. The tasks that lead with DeepSeek are the ones that actually buy
something with the price: reasoning, schema-constrained output and long context.

DeepSeek additionally requires the Workers Paid plan or prepaid AI Gateway
credits. It is never alone in a chain, so an account without either degrades to
the next tier rather than failing.

Qwen leads image *understanding*; nothing here generates images. Reference
images attached to a booking enquiry are still **not** analysed — nothing in the
intake path calls the router, and turning that on is a product and privacy
decision, not a routing one.

## Configuration

Routing is server-side configuration, in `wrangler.toml` `[vars]` or as Worker
variables. Nothing is decided in the browser and nothing reaches it.

| Variable | Effect |
|---|---|
| `AI_ROUTE_<TASK>` | ordered tier list, e.g. `workers_ai,deepseek` |
| `AI_MODEL_DEEPSEEK_TEXT` | DeepSeek model id, must match `@cf/...` |
| `AI_MODEL_QWEN_VISION` / `AI_MODEL_QWEN_TEXT` | Qwen model ids, must match `@cf/...` |
| `AI_MODEL_WORKERS_AI_TEXT` | Llama model id, must match `@cf/...` |
| `AI_MODEL_OPENAI_TEXT` / `AI_MODEL_OPENAI_VISION` | OpenAI model ids |

An override that names an unknown tier, repeats one, exceeds the two-tier cap or
fails the model-id pattern is ignored and the compiled default stands. A model
id that is not a Cloudflare `@cf/...` id is rejected on the binding-backed
tiers, so a stray vendor model name cannot silently redirect a chain.

### Secrets

There is one, and it is optional: `OPENAI_API_KEY`, a Worker secret. The
binding-backed tiers have no credential at all — a tier is "configured" exactly
when `env.AI` is present, and billing runs through the Cloudflare account.

## Cost controls

- at most **2 providers** per request (`MAX_PROVIDERS_PER_REQUEST`);
- **1 attempt** per provider — no retry loop inside a chain;
- per-task timeout, hard-capped at 30s, enforced with `AbortController`;
- per-task output ceiling, hard-capped at 2000 tokens;
- input bounded to 12k characters, system prompt to 20k;
- vision bounded to 2 images, 1.5 MB each, JPEG/PNG/WebP only;
- oversized or malformed requests are rejected **before** any provider call;
- fallback only for codes the next provider could plausibly survive
  (timeout, rate limit, unavailable, HTTP error, malformed/empty body, invalid
  structured output). A configuration or request fault fails immediately.

## Observability

Each attempt and each completion emits an allow-listed log line:
`task`, `capability`, `provider`, `model`, `outcome`, `errorCode`, `durationMs`,
`fallbackUsed`, `providerAttempts`, `outputChars`, `imageCount`.

Never emitted: prompts, model output, client text, reference images, API keys,
provider response bodies or provider error strings. Provider failures are
collapsed to the bounded codes in `workers/lib/ai/errors.js` before they reach a
log, and `workers/lib/logging.js` drops any field not on its allow-list.

## Operator readback and probe

`/internal/ai-router` on the tattooai Worker, **404 unless** both
`AI_ROUTER_PROBE_ENABLED=true` and an `AI_ROUTER_PROBE_TOKEN` of at least 32
characters are set. Requires `Authorization: Bearer <token>`; emits no CORS
headers, so a browser cannot reach it.

- `GET` — configuration readback: which providers hold credentials (boolean
  only) and how every task currently resolves.
- `POST {"task": "..."}` — one live request built from a **fixed synthetic
  prompt**, and for vision a fixed 16×16 generated PNG. Caller-supplied text and
  images are ignored, so the probe cannot become a relay to a paid API or touch
  client data. Returns the provider, model, fallback state, per-attempt timings
  and a short preview of the model's answer to that synthetic prompt.

Run it with the `AI router production probe` workflow rather than by hand. It
reads back the live routing, probes the DeepSeek and Qwen tiers with fixed
synthetic payloads, confirms the public assistants still answer, and closes the
window again.

## Adding a provider

1. New adapter under `workers/lib/ai/providers/` exporting `id`, `modalities`,
   `configure(env, modality)` and `invoke({config, request, fetchImpl, signal})`.
   Everything provider-shaped — URL, auth, body, response parsing, model ids —
   stays inside it. A Cloudflare-hosted tier can reuse
   `providers/workers-ai-binding.js` for the transport; an external one can reuse
   `providers/chat-completions.js`.
2. Register it in `PROVIDERS` in `workers/lib/ai/router.js`.
3. Add it to the relevant chains in `workers/lib/ai/tasks.js`.
4. Extend `scripts/test-ai-model-router.mjs`.

No CRM or site code changes for any of that.
