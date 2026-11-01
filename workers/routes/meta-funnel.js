// Server-to-server Meta funnel aggregates for the Vishar Meta Analytics Worker.
//
//   GET /internal/meta-funnel?account_id=act_<digits>&since=YYYY-MM-DD&until=YYYY-MM-DD
//   x-vishar-timestamp: <unix seconds>
//   x-vishar-signature: hex HMAC-SHA256(key_for_account,
//     "vishar-crm-funnel\nv1\n<timestamp>\n<account_id>\n<since>\n<until>")
//
// Contract: docs/integrations/meta-crm-funnel.md. Aggregates only; the
// database function decides the artist from the verified ad account registry
// and suppresses small counts. Nothing here reads or returns personal data.
//
// Off unless META_FUNNEL_KEYS (secret JSON {"act_…": "<>=32 chars>"}) holds a
// key for the requested account. Unknown, disabled or unauthenticated requests
// all answer 404 with no body detail, the same as an unknown path, and no CORS.

import { createSupabaseClient } from '../lib/supabase.js';

const PATH = '/internal/meta-funnel';
const MAX_SKEW_SECONDS = 300;
const MIN_KEY_LENGTH = 32;
const ACCOUNT = /^act_[0-9]{5,30}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
});

export const signingInput = (ts, account, since, until) =>
  ['vishar-crm-funnel', 'v1', String(ts), account, since, until].join('\n');

export function isMetaFunnelPath(request) {
  try {
    return new URL(request.url).pathname === PATH;
  } catch {
    return false;
  }
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

function keyFor(env, account) {
  let keys;
  try {
    keys = JSON.parse(typeof env?.META_FUNNEL_KEYS === 'string' ? env.META_FUNNEL_KEYS : '');
  } catch {
    return '';
  }
  const key = keys && typeof keys === 'object' && !Array.isArray(keys) ? keys[account] : undefined;
  return typeof key === 'string' && key.length >= MIN_KEY_LENGTH ? key : '';
}

function validDay(value) {
  if (!DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

async function hmacHex(key, input) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(input));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent comparison of two lowercase hex strings. */
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Only the fields of the contract leave the Worker, rebuilt one by one.
const ID = /^[0-9]{10,25}$/;
const METRICS = ['enquiries', 'consultations', 'confirmed_projects', 'deposits_count', 'deposits_minor'];
export function projectFunnel(payload, account) {
  if (!payload || payload.version !== 1 || payload.account_id !== account || !Array.isArray(payload.rows)) return null;
  const rows = [];
  for (const r of payload.rows) {
    if (!r || !DAY.test(r.date) || typeof r.ad_id !== 'string' || !ID.test(r.ad_id)) return null;
    const row = { date: r.date, ad_id: r.ad_id };
    if (typeof r.campaign_id === 'string' && ID.test(r.campaign_id)) row.campaign_id = r.campaign_id;
    for (const m of METRICS) {
      const v = r[m];
      if (v !== null && !(Number.isSafeInteger(v) && v >= 0)) return null;
      row[m] = v;
    }
    rows.push(row);
  }
  return { version: 1, account_id: account, currency: 'GBP', date_basis: 'meta_account_local', rows };
}

export async function handleMetaFunnelRequest(request, env, { fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (request.method !== 'GET') return notFound();
  const url = new URL(request.url);
  const params = url.searchParams;
  const account = params.get('account_id') || '';
  const since = params.get('since') || '';
  const until = params.get('until') || '';
  if ([...params.keys()].some((k) => !['account_id', 'since', 'until'].includes(k))) return notFound();
  if (!ACCOUNT.test(account) || !validDay(since) || !validDay(until) || until < since) return notFound();
  if (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`) > 89 * 86400000) return notFound();

  const key = keyFor(env, account);
  if (!key) return notFound();
  const tsHeader = request.headers.get('x-vishar-timestamp') || '';
  const signature = (request.headers.get('x-vishar-signature') || '').toLowerCase();
  if (!/^\d{9,11}$/.test(tsHeader) || !HEX64.test(signature)) return notFound();
  if (Math.abs(now() - Number(tsHeader)) > MAX_SKEW_SECONDS) return notFound();
  const expected = await hmacHex(key, signingInput(tsHeader, account, since, until));
  if (!sameHex(signature, expected)) return notFound();

  let payload;
  try {
    const supabase = createSupabaseClient(env, fetchImpl);
    payload = await supabase.rpc('service_meta_crm_funnel', {
      p_ad_account_id: account.slice(4),
      p_since: since,
      p_until: until,
    });
  } catch {
    return new Response(JSON.stringify({ error: 'crm_unavailable' }), { status: 503, headers: HEADERS });
  }
  const body = projectFunnel(payload, account);
  if (!body) return new Response(JSON.stringify({ error: 'crm_invalid_response' }), { status: 502, headers: HEADERS });
  return new Response(JSON.stringify(body), { status: 200, headers: HEADERS });
}
