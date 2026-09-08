# Model routing

## What this replaces

Before this layer there was exactly one model call in the whole system:
`workers/tattooai.js` invoked the Cloudflare `AI` binding with
`@cf/meta/llama-3.1-8b-instruct` for the two public assistants. There was no
outbound OpenAI path anywhere in the CRM — the `gpt-actions` Workers are the
opposite direction, an OpenAPI surface a Custom GPT calls *into*.

So "keep the OpenAI path as a fallback" had nothing to keep. What exists now:

- a capability router every model call goes through;
- four provider adapters behind it — DeepSeek, Qwen, OpenAI and the incumbent
  Workers AI binding;
- the two live public tasks still ending on Workers AI, so the site behaves
  exactly as before while no external key is configured.

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

## Tasks and where they route

| Task | Modality | Default chain | Live today |
|---|---|---|---|
| `concept_consult` | text | DeepSeek → Workers AI | yes, `/ai-tools/` idea assistant |
| `aftercare_support` | text | DeepSeek → Workers AI | yes, `/aftercare/` assistant |
| `text_summarization` | text | DeepSeek → Workers AI | declared |
| `text_classification` | text, JSON | DeepSeek → OpenAI | declared |
| `text_extraction` | text, JSON | DeepSeek → OpenAI | declared |
| `high_quality_reasoning` | text | OpenAI → DeepSeek | declared |
| `vision_reference_understanding` | vision | Qwen → OpenAI | declared |
| `vision_document_extraction` | vision, JSON | Qwen → OpenAI | declared |

DeepSeek leads where a cheaper model is good enough and a fallback exists. Qwen
leads image *understanding*; no image generation moved anywhere. OpenAI leads
where judgement quality is the point and backs up the cheaper tiers everywhere
else, which is what stops any single provider becoming a hard dependency.

Reference images attached to a booking enquiry are **not** analysed. Nothing in
the intake path calls the router, and turning that on is a product and privacy
decision, not a routing one.

## Configuration

Routing is server-side configuration, in `wrangler.toml` `[vars]` or as Worker
variables. Nothing is decided in the browser and nothing reaches it.

| Variable | Effect |
|---|---|
| `AI_ROUTE_<TASK>` | ordered provider list, e.g. `deepseek,workers_ai` |
| `AI_MODEL_DEEPSEEK_TEXT` | DeepSeek model id |
| `AI_MODEL_QWEN_VISION` / `AI_MODEL_QWEN_TEXT` | Qwen model ids |
| `AI_MODEL_OPENAI_TEXT` / `AI_MODEL_OPENAI_VISION` | OpenAI model ids |
| `AI_MODEL_WORKERS_AI_TEXT` | Workers AI model id |
| `AI_QWEN_BASE_URL` | DashScope region endpoint, restricted to `*.aliyuncs.com` |

An override that names an unknown provider, repeats one, exceeds the two-provider
cap or fails the model-id pattern is ignored and the compiled default stands.

### Secrets

API keys are Worker **secrets**, never repository content and never `[vars]`:

- `DEEPSEEK_API_KEY`
- `QWEN_API_KEY`
- `OPENAI_API_KEY`

A provider with no key configured is skipped during selection — it is never
attempted and never counted as a fallback. With none of the three set, both live
public chains resolve to Workers AI and the site is unchanged.

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

Keep it disabled outside a release readback window.

## Adding a provider

1. New adapter under `workers/lib/ai/providers/` exporting `id`, `modalities`,
   `configure(env, modality)` and `invoke({config, request, fetchImpl, signal})`.
   Everything provider-shaped — URL, auth, body, response parsing, model ids —
   stays inside it.
2. Register it in `PROVIDERS` in `workers/lib/ai/router.js`.
3. Add it to the relevant chains in `workers/lib/ai/tasks.js`.
4. Extend `scripts/test-ai-model-router.mjs`.

No CRM or site code changes for any of that.
