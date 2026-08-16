const APP_ID = '1481226093843982';
const GRAPH_VERSION = 'v25.0';
const ALLOWED_ORIGIN = 'https://vishar-crm-staging.pages.dev';
const MAX_BODY_BYTES = 4096;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'pragma': 'no-cache',
      'x-content-type-options': 'nosniff'
    }
  });
}

function isNumericId(value) {
  return typeof value === 'string' && /^[0-9]{5,30}$/.test(value);
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new Error('body_too_large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error('body_too_large');
  }
  return JSON.parse(text);
}

async function graphJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const graphCode = payload && payload.error && Number.isInteger(payload.error.code)
      ? payload.error.code
      : null;
    const error = new Error('graph_request_failed');
    error.graphCode = graphCode;
    error.httpStatus = response.status;
    throw error;
  }
  return payload;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('origin');
  if (origin !== ALLOWED_ORIGIN) return json({ ok: false, error: 'origin_not_allowed' }, 403);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return json({ ok: false, error: 'json_required' }, 415);
  }

  if (!env.META_APP_SECRET) {
    return json({ ok: false, error: 'server_secret_not_configured' }, 503);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const reason = error && error.message === 'body_too_large' ? 'body_too_large' : 'invalid_json';
    return json({ ok: false, error: reason }, reason === 'body_too_large' ? 413 : 400);
  }

  const code = body && typeof body.code === 'string' ? body.code.trim() : '';
  if (!code || code.length < 10 || code.length > 2048) {
    return json({ ok: false, error: 'invalid_code' }, 400);
  }

  const session = body && body.session && typeof body.session === 'object' ? body.session : {};
  const wabaId = isNumericId(session.waba_id) ? session.waba_id : null;
  const phoneNumberId = isNumericId(session.phone_number_id) ? session.phone_number_id : null;

  try {
    const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', APP_ID);
    tokenUrl.searchParams.set('client_secret', env.META_APP_SECRET);
    tokenUrl.searchParams.set('code', code);

    const tokenPayload = await graphJson(tokenUrl.toString(), { method: 'GET' });
    const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : '';
    if (!accessToken) return json({ ok: false, error: 'token_exchange_failed' }, 502);

    let waba = null;
    let phones = [];

    if (wabaId) {
      const wabaUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}`);
      wabaUrl.searchParams.set('fields', 'id,name');
      const wabaPayload = await graphJson(wabaUrl.toString(), {
        headers: { authorization: `Bearer ${accessToken}` }
      });
      waba = {
        id: typeof wabaPayload.id === 'string' ? wabaPayload.id : wabaId,
        name: typeof wabaPayload.name === 'string' ? wabaPayload.name : null
      };

      const phonesUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/phone_numbers`);
      phonesUrl.searchParams.set('fields', 'id,display_phone_number,verified_name');
      const phonePayload = await graphJson(phonesUrl.toString(), {
        headers: { authorization: `Bearer ${accessToken}` }
      });
      phones = Array.isArray(phonePayload.data)
        ? phonePayload.data.slice(0, 20).map((item) => ({
            id: typeof item.id === 'string' ? item.id : null,
            display_phone_number: typeof item.display_phone_number === 'string' ? item.display_phone_number : null,
            verified_name: typeof item.verified_name === 'string' ? item.verified_name : null
          }))
        : [];
    }

    return json({
      ok: true,
      exchange: 'verified',
      session: {
        waba_id: wabaId,
        phone_number_id: phoneNumberId
      },
      waba,
      phones
    });
  } catch (error) {
    return json({
      ok: false,
      error: 'meta_exchange_or_lookup_failed',
      graph_code: Number.isInteger(error && error.graphCode) ? error.graphCode : null,
      upstream_status: Number.isInteger(error && error.httpStatus) ? error.httpStatus : null
    }, 502);
  }
}

export function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
