// Artist-scoped GPT Actions proxy.
//
// This proxy never holds a Supabase service key. It forwards the caller's
// Supabase OAuth access token to named, bounded RPCs and adds only the public
// project key required by the Supabase API gateway. Artist scope is resolved by
// the database from the OAuth token's client_id claim.

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const ENQUIRY_STATUSES = new Set([
  'new', 'reviewing', 'waiting_for_client', 'accepted', 'declined',
  'quote_sent', 'deposit_requested', 'deposit_paid', 'converted', 'closed',
]);
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function configured(env) {
  return env?.GPT_ACTIONS_ENABLED === 'true'
    && typeof env?.SUPABASE_URL === 'string'
    && /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(env.SUPABASE_URL)
    && typeof env?.SUPABASE_PUBLISHABLE_KEY === 'string'
    && env.SUPABASE_PUBLISHABLE_KEY.length >= 20;
}

function bearer(request) {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1] || null;
}

async function readJson(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new Error('unsupported_media_type');
  }

  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error('body_too_large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error('body_too_large');
  }
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('invalid_json_object');
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_json_object') throw error;
    throw new Error('invalid_json');
  }
}

function exactObject(value, allowed) {
  for (const forbidden of ['artist_id', 'oauth_client_id', 'integration_key', 'sql', 'query']) {
    if (Object.prototype.hasOwnProperty.call(value, forbidden)) {
      throw new Error(`forbidden_field:${forbidden}`);
    }
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new Error(`unexpected_field:${unexpected[0]}`);
  }
  return value;
}

function exactSearchParams(searchParams, allowed) {
  for (const key of searchParams.keys()) {
    if (['artist_id', 'oauth_client_id', 'integration_key', 'sql'].includes(key)) {
      throw new Error(`forbidden_field:${key}`);
    }
    if (!allowed.includes(key)) throw new Error(`unexpected_field:${key}`);
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`required_field:${name}`);
  }
  return value;
}

function optionalString(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`invalid_field:${name}`);
  return value;
}

function optionalEnum(value, name, allowed) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !allowed.has(value)) throw new Error(`invalid_field:${name}`);
  return value;
}

function optionalInteger(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value)) throw new Error(`invalid_field:${name}`);
  return value;
}

function boundedQueryInteger(value, name, fallback, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`invalid_field:${name}`);
  }
  return parsed;
}

function routeFor(request, url, body) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (method === 'GET' && path === '/v1/clients/search') {
    exactSearchParams(url.searchParams, ['q', 'limit']);
    return {
      rpc: 'gpt_search_clients',
      payload: {
        p_query: requiredString(url.searchParams.get('q'), 'q'),
        p_limit: boundedQueryInteger(url.searchParams.get('limit'), 'limit', 10, 20),
      },
      responseKind: 'list',
    };
  }

  if (method === 'GET' && path === '/v1/enquiries') {
    exactSearchParams(url.searchParams, ['from', 'to', 'status', 'limit']);
    return {
      rpc: 'gpt_list_enquiries',
      payload: {
        p_from: optionalString(url.searchParams.get('from'), 'from'),
        p_to: optionalString(url.searchParams.get('to'), 'to'),
        p_status: optionalEnum(url.searchParams.get('status'), 'status', ENQUIRY_STATUSES),
        p_limit: boundedQueryInteger(url.searchParams.get('limit'), 'limit', 20, 25),
      },
      responseKind: 'list',
    };
  }

  const enquiryMatch = new RegExp(`^/v1/enquiries/(${UUID_PATTERN})$`).exec(path);
  if (method === 'GET' && enquiryMatch) {
    return {
      rpc: 'gpt_get_enquiry',
      payload: { p_enquiry_id: enquiryMatch[1] },
      responseKind: 'single-row',
      notFoundError: 'enquiry_not_found',
    };
  }

  if (method === 'GET' && path === '/v1/appointments') {
    exactSearchParams(url.searchParams, ['from', 'to', 'limit']);
    return {
      rpc: 'gpt_list_appointments',
      payload: {
        p_from: requiredString(url.searchParams.get('from'), 'from'),
        p_to: requiredString(url.searchParams.get('to'), 'to'),
        p_limit: boundedQueryInteger(url.searchParams.get('limit'), 'limit', 20, 25),
      },
      responseKind: 'list',
    };
  }

  const appointmentMatch = new RegExp(`^/v1/appointments/(${UUID_PATTERN})$`).exec(path);
  if (method === 'GET' && appointmentMatch) {
    return {
      rpc: 'gpt_get_appointment',
      payload: { p_appointment_id: appointmentMatch[1] },
      responseKind: 'single-row',
      notFoundError: 'appointment_not_found',
    };
  }

  if (method === 'POST' && path === '/v1/appointments/conflicts') {
    exactObject(body, ['start_at', 'end_at', 'exclude_appointment_id']);
    return {
      rpc: 'gpt_list_appointment_conflicts',
      payload: {
        p_start_at: requiredString(body.start_at, 'start_at'),
        p_end_at: requiredString(body.end_at, 'end_at'),
        p_exclude_appointment_id: optionalString(body.exclude_appointment_id, 'exclude_appointment_id'),
      },
      responseKind: 'list',
    };
  }

  if (method === 'POST' && path === '/v1/appointments') {
    exactObject(body, [
      'request_id', 'client_id', 'appointment_type', 'start_at', 'end_at',
      'status', 'enquiry_id', 'project_id', 'notes',
    ]);
    return {
      rpc: 'gpt_schedule_appointment',
      payload: {
        p_request_id: requiredString(body.request_id, 'request_id'),
        p_client_id: requiredString(body.client_id, 'client_id'),
        p_appointment_type: requiredString(body.appointment_type, 'appointment_type'),
        p_start_at: requiredString(body.start_at, 'start_at'),
        p_end_at: requiredString(body.end_at, 'end_at'),
        p_status: body.status == null ? 'proposed' : requiredString(body.status, 'status'),
        p_enquiry_id: optionalString(body.enquiry_id, 'enquiry_id'),
        p_project_id: optionalString(body.project_id, 'project_id'),
        p_notes: optionalString(body.notes, 'notes'),
      },
      responseKind: 'object',
    };
  }

  const timeMatch = new RegExp(`^/v1/appointments/(${UUID_PATTERN})/time$`).exec(path);
  if (method === 'PATCH' && timeMatch) {
    exactObject(body, ['request_id', 'expected_calendar_version', 'start_at', 'end_at']);
    return {
      rpc: 'gpt_reschedule_appointment',
      payload: {
        p_request_id: requiredString(body.request_id, 'request_id'),
        p_appointment_id: timeMatch[1],
        p_expected_calendar_version: optionalInteger(
          body.expected_calendar_version,
          'expected_calendar_version',
        ),
        p_start_at: requiredString(body.start_at, 'start_at'),
        p_end_at: requiredString(body.end_at, 'end_at'),
      },
      responseKind: 'object',
    };
  }

  const cancelMatch = new RegExp(`^/v1/appointments/(${UUID_PATTERN})/cancel$`).exec(path);
  if (method === 'POST' && cancelMatch) {
    exactObject(body, ['request_id', 'expected_calendar_version']);
    return {
      rpc: 'gpt_cancel_appointment',
      payload: {
        p_request_id: requiredString(body.request_id, 'request_id'),
        p_appointment_id: cancelMatch[1],
        p_expected_calendar_version: optionalInteger(
          body.expected_calendar_version,
          'expected_calendar_version',
        ),
      },
      responseKind: 'object',
    };
  }

  return null;
}

function safeRpcError(status, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const code = typeof parsed?.code === 'string' ? parsed.code : 'upstream_error';
  const messages = {
    '40001': 'The appointment changed since it was read. Refresh it before changing it.',
    '42501': 'This action is not permitted for the current GPT or artist scope.',
    '23503': 'A referenced CRM record was not found.',
    '23514': 'The request violates CRM validation rules.',
  };
  const message = code === '22023' && typeof parsed?.message === 'string'
    ? parsed.message.slice(0, 300)
    : messages[code] || 'The CRM action could not be completed.';
  const mapped = status === 401 ? 401
    : status === 403 || code === '42501' ? 403
      : code === '40001' ? 409
        : code === '23503' ? 404
          : status >= 400 && status < 500 ? 400
            : 502;
  return json(mapped, { error: code, message });
}

export async function handleGptActionsRequest(request, env, fetchImpl = fetch) {
  if (!configured(env)) return json(404, { error: 'not_found' });

  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(200, { status: 'ok' });
  }

  const token = bearer(request);
  if (!token) return json(401, { error: 'oauth_token_required' });

  let body = {};
  try {
    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      body = await readJson(request);
    }
    const route = routeFor(request, url, body);
    if (!route) return json(404, { error: 'not_found' });

    const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${route.rpc}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(route.payload),
      redirect: 'error',
    });

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      return json(502, { error: 'upstream_response_too_large' });
    }
    if (!response.ok) return safeRpcError(response.status, text);

    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return json(502, { error: 'invalid_upstream_response' });
    }
    if (route.responseKind === 'single-row') {
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return json(404, { error: route.notFoundError || 'record_not_found' });
      }
      return json(200, parsed[0]);
    }
    if (route.responseKind === 'list') {
      return json(200, Array.isArray(parsed) ? parsed : []);
    }
    return json(200, parsed && typeof parsed === 'object' ? parsed : {});
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_request';
    if (reason === 'body_too_large') return json(413, { error: reason });
    if (reason === 'unsupported_media_type') return json(415, { error: reason });
    const [kind, field] = reason.split(':', 2);
    if (['unexpected_field', 'forbidden_field', 'required_field', 'invalid_field'].includes(kind)) {
      return json(400, { error: kind, field });
    }
    if (reason === 'invalid_json' || reason === 'invalid_json_object') {
      return json(400, { error: reason });
    }
    return json(502, { error: 'gateway_error' });
  }
}

export const __testing = Object.freeze({
  configured,
  bearer,
  exactObject,
  routeFor,
});
