// Operator-only "Suggest reply": one draft for the CRM composer
// (specs/reply-drafts). Facts and examples come only from the authorised
// database RPC, never from the browser. Nothing is queued, sent or stored:
// the artist edits the text and presses Send through the existing path.
import { runModelTask } from '../lib/ai/router.js';
import { REPLY_DRAFT_SYSTEM, buildDraftInput, diagnoseDraft, latestClientText } from '../lib/ai/reply-draft.js';

const PATH = '/crm/reply-draft';
const CRM_ORIGINS = new Set(['https://crm.vishartattoo.com', 'https://app.vishartattoo.com']);
const TOKEN_RE = /^[A-Za-z0-9._~-]{32,8192}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAYLOAD = 200;
const MAX_MODEL_INPUT = 11_500;

function headers(request) {
  const origin = request.headers.get('Origin');
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(CRM_ORIGINS.has(origin) ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '300',
      Vary: 'Origin',
    } : {}),
  };
}
const respond = (request, status, data) => Response.json(data, { status, headers: headers(request) });

export function isReplyDraftPath(request) {
  try { return new URL(request.url).pathname === PATH; }
  catch { return false; }
}

export async function handleReplyDraft(request, env, deps = {}) {
  if (env.REPLY_DRAFTS_ENABLED !== 'true') return respond(request, 404, { error: 'not_found' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(request) });
  if (request.method !== 'POST') return respond(request, 405, { error: 'method_not_allowed' });
  if (!CRM_ORIGINS.has(request.headers.get('Origin'))) return respond(request, 403, { error: 'origin_denied' });
  if (!String(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json'))
    return respond(request, 415, { error: 'invalid_content_type' });
  const token = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/)?.[1];
  if (!TOKEN_RE.test(token || '')) return respond(request, 401, { error: 'authentication_required' });
  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_PAYLOAD) return respond(request, 413, { error: 'request_too_long' });
    body = JSON.parse(raw);
  } catch { return respond(request, 400, { error: 'invalid_json' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || !UUID_RE.test(body.conversation_id || ''))
    return respond(request, 400, { error: 'invalid_request' });

  const base = String(env.SUPABASE_URL || '');
  const publishable = String(env.SUPABASE_PUBLISHABLE_KEY || '');
  let origin;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname)
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('bad_host');
    origin = parsed.origin;
  } catch { return respond(request, 503, { error: 'draft_unavailable' }); }
  if (!publishable.startsWith('sb_publishable_')) return respond(request, 503, { error: 'draft_unavailable' });

  const fetchImpl = deps.fetchImpl ?? fetch;
  let context;
  try {
    const res = await fetchImpl(origin + '/rest/v1/rpc/get_reply_draft_context', {
      method: 'POST', redirect: 'manual',
      headers: {
        apikey: publishable,
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ p_conversation_id: body.conversation_id }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 401 || res.status === 403) return respond(request, 403, { error: 'access_denied' });
    if (!res.ok) return respond(request, 503, { error: 'draft_unavailable' });
    context = await res.json();
  } catch { return respond(request, 503, { error: 'draft_unavailable' }); }
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || !['whatsapp', 'instagram'].includes(context.channel))
    return respond(request, 503, { error: 'draft_unavailable' });

  // Said before drafting, so the artist does not edit a reply CRM cannot send.
  if (context.channel === 'whatsapp' && context.whatsapp_window_open !== true)
    return respond(request, 409, { error: 'whatsapp_window_closed' });
  if (!latestClientText(context.messages)) return respond(request, 422, { error: 'nothing_to_answer' });

  const input = buildDraftInput(context, MAX_MODEL_INPUT - 500);
  if (input.length > MAX_MODEL_INPUT) return respond(request, 413, { error: 'draft_context_too_long' });
  let routed;
  try {
    routed = await (deps.runTask ?? runModelTask)(
      env, 'reply_draft', { system: REPLY_DRAFT_SYSTEM, input },
      { validateJson: (json) => diagnoseDraft(json, context) ?? true },
    );
  } catch { return respond(request, 503, { error: 'draft_unavailable' }); }
  if (!routed?.ok || diagnoseDraft(routed.json, context) !== null)
    return respond(request, 503, { error: 'draft_unavailable' });
  return respond(request, 200, { ok: true, draft: routed.json.draft.trim() });
}
