// Separate, read-only App Review endpoint. Disabled until a single review Auth
// identity, expiry and Meta redirect URI are provisioned. No CRM profile needed.
const SUPABASE = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const CRM = 'https://crm.vishartattoo.com';
const REDIRECT = `${CRM}/meta-review-business.html`;
const APP = '1481226093843982';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKED = new Set(['692776505711216', '462106700328578']);
function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  } });
}
function config(env) {
  const id = env.META_REVIEW_CRM_USER_ID;
  const expiry = Date.parse(env.META_REVIEW_ACCESS_EXPIRES_AT || '');
  if (env.META_REVIEWER_ACCESS_ENABLED !== 'true' || !UUID.test(id || '')
    || !Number.isFinite(expiry) || Date.now() >= expiry
    || !env.SUPABASE_PUBLISHABLE_KEY || !env.META_APP_SECRET) return null;
  return { id, key: env.SUPABASE_PUBLISHABLE_KEY, secret: env.META_APP_SECRET };
}
async function authorized(request, cfg) {
  const bearer = /^Bearer ([^\s]{20,4096})$/.exec(request.headers.get('authorization') || '');
  if (!bearer) return false;
  const r = await fetch(`${SUPABASE}/auth/v1/user`, { redirect: 'manual', headers: {
    apikey: cfg.key, authorization: `Bearer ${bearer[1]}`,
  } });
  if (!r.ok) return false;
  const user = await r.json().catch(() => null);
  if (user?.id !== cfg.id) return false;
  // A review identity with a CRM profile could acquire other data permissions.
  const p = new URL(`${SUPABASE}/rest/v1/profiles`);
  p.searchParams.set('id', `eq.${cfg.id}`);
  p.searchParams.set('select', 'id');
  const profile = await fetch(p, { redirect: 'manual', headers: {
    apikey: cfg.key, authorization: `Bearer ${bearer[1]}`,
  } });
  return profile.ok && (await profile.json().catch(() => null))?.length === 0;
}
async function graph(path, token) {
  const r = await fetch(`https://graph.facebook.com/v25.0/${path}`, {
    redirect: 'manual', headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('meta_graph_failed');
  return r.json();
}
export async function onRequest({ request, env }) {
  const origin = request.headers.get('origin');
  if (new URL(request.url).origin !== CRM || (origin !== CRM && !(request.method === 'GET' && origin === null)))
    return response({ ok: false, error: 'origin_not_allowed' }, 403);
  const cfg = config(env);
  if (!cfg) return response({ ok: false, error: 'review_disabled' }, 404);
  if (request.method !== 'GET' && request.method !== 'POST') return response({ ok: false }, 405);
  try {
    if (!await authorized(request, cfg)) return response({ ok: false, error: 'reviewer_required' }, 403);
    if (request.method === 'GET') return response({ ok: true });
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) return response({ ok: false }, 415);
    if (Number(request.headers.get('content-length') || 0) > 4096) return response({ ok: false }, 413);
    const raw = await request.text();
    if (raw.length > 4096) return response({ ok: false }, 413);
    const { code } = JSON.parse(raw);
    if (typeof code !== 'string' || !/^[\x21-\x7e]{10,2048}$/.test(code)) return response({ ok: false }, 400);
    const exchange = await fetch('https://graph.facebook.com/v25.0/oauth/access_token', {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: APP, client_secret: cfg.secret, code,
        redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    });
    if (!exchange.ok) return response({ ok: false, error: 'code_exchange_failed' }, 424);
    const token = (await exchange.json()).access_token;
    if (typeof token !== 'string' || token.length < 20) return response({ ok: false }, 424);
    const permissions = await graph('me/permissions?fields=permission,status&limit=100', token);
    if (!permissions.data?.some(p => p.permission === 'business_management' && p.status === 'granted'))
      return response({ ok: false, error: 'permission_not_granted' }, 409);
    const businesses = await graph('me/businesses?fields=id,name&limit=100', token);
    const safe = businesses.data?.filter(b => /^\d{6,30}$/.test(String(b.id)) && !BLOCKED.has(String(b.id))) || [];
    if (safe.length === 0) return response({ ok: false, error: 'no_review_business_accessible' }, 409);
    return response({ ok: true, permission: 'business_management',
      businesses: safe.map(b => ({ id: String(b.id), name: String(b.name || '').slice(0, 100) })) });
  } catch {
    return response({ ok: false, error: 'review_failed' }, 424);
  }
}
