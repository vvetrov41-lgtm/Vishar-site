// Closed projection of backend response metadata. Never accept request data.
export const DIAGNOSTIC_EVENT = 'supabase_backend_response';
export const OBSERVED_RPCS = Object.freeze({
  claim_telegram_outbox: 'telegram_outbox',
  service_claim_telegram_notifications: 'telegram_notifications',
  service_run_automation_tick: 'automation_tick',
  service_record_automation_scheduler_heartbeat: 'scheduler_heartbeat',
  service_sweep_lifecycle_failure_alerts: 'lifecycle_alerts',
  claim_calendar_outbox: 'calendar_outbox',
  claim_calendar_availability_outbox: 'calendar_availability',
  claim_email_outbox: 'gmail_outbox',
});
const CODES = new Set(['PGRST300', 'PGRST301', 'PGRST302', 'PGRST303', '42501', '28000', '28P01',
  'bad_jwt', 'invalid_jwt', 'invalid_api_key', 'missing_api_key']);
const REASONS = Object.freeze({
  'JWT expired': 'jwt_expired', 'JWT is expired': 'jwt_expired',
  'JWT not yet valid': 'jwt_not_yet_valid', 'Invalid JWT': 'invalid_jwt',
  'Invalid API key': 'invalid_api_key', 'No API key found in request': 'missing_api_key',
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RAY = /^[a-f0-9]{16}-[a-z]{3}$/i;
const GATEWAY_VERSION = /^[0-9]{1,3}$/;
const BODY_STATES = new Set(['not_read', 'not_json', 'too_large', 'parsed', 'timeout', 'unavailable']);
const MAX_BYTES = 4096;
const TIMEOUT_MS = 500;
const MAX_EVENTS = 16;
const safeId = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value.toLowerCase() : null;

export function classifyBackendStatus(status) {
  return status === 401 ? 'unauthorized' : status === 403 ? 'forbidden'
    : status >= 500 ? 'server_error' : status >= 400 ? 'request_error'
      : status >= 300 ? 'redirect' : 'success';
}

// Also used by the operator-side tail parser, which treats every log as untrusted.
export function sanitizeBackendDiagnostic(value) {
  if (!value || value.event !== DIAGNOSTIC_EVENT || value.schema_version !== 1
    || !Object.hasOwn(OBSERVED_RPCS, value.rpc)
    || !['shared_backend', 'gmail_backend'].includes(value.client)
    || !['secret', 'legacy_service_role'].includes(value.key_kind)
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || ![1, 2].includes(value.attempt)
    || typeof value.received_at !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.received_at)
    || !Number.isFinite(Date.parse(value.received_at))) return null;
  return {
    event: DIAGNOSTIC_EVENT, schema_version: 1, rpc: value.rpc,
    task: OBSERVED_RPCS[value.rpc], client: value.client, key_kind: value.key_kind,
    status: value.status, classification: classifyBackendStatus(value.status), attempt: value.attempt,
    supabase_code: CODES.has(value.supabase_code) ? value.supabase_code : null,
    auth_reason: Object.values(REASONS).includes(value.auth_reason) ? value.auth_reason : null,
    sb_gateway_version: typeof value.sb_gateway_version === 'string' && GATEWAY_VERSION.test(value.sb_gateway_version)
      ? value.sb_gateway_version : null,
    x_sb_error_code: CODES.has(value.x_sb_error_code) ? value.x_sb_error_code : null,
    sb_request_id: safeId(value.sb_request_id, UUID), request_id: safeId(value.request_id, UUID),
    cf_ray: safeId(value.cf_ray, RAY), received_at: value.received_at,
    duration_ms: Number.isFinite(value.duration_ms) ? Math.max(0, Math.min(60000, Math.round(value.duration_ms))) : null,
    body_state: BODY_STATES.has(value.body_state) ? value.body_state : 'unavailable',
  };
}

export async function readSafeSupabaseError(response) {
  const empty = (body_state) => ({ supabase_code: null, auth_reason: null, body_state });
  if (response.ok) return empty('not_read');
  let reader;
  let timer;
  try {
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get('content-type') || '')) return empty('not_json');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return empty('too_large');
    reader = response.body?.getReader();
    if (!reader) return empty('unavailable');
    const read = async () => {
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) return empty('too_large');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const json = JSON.parse(new TextDecoder().decode(bytes));
      return {
        supabase_code: CODES.has(json?.code) ? json.code : null,
        auth_reason: typeof json?.message === 'string' && Object.hasOwn(REASONS, json.message) ? REASONS[json.message] : null,
        body_state: 'parsed',
      };
    };
    return await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => resolve(empty('timeout')), TIMEOUT_MS); })]);
  } catch { return empty('unavailable'); }
  finally { clearTimeout(timer); try { reader?.cancel()?.catch(() => {}); } catch { /* diagnostic only */ } }
}

export function createBackendResponseObserver(client, keyKind, emit = line => console.log(line)) {
  let count = 0;
  return async (rpc, response, startedAt, attempt = 1) => {
    const receivedAt = new Date().toISOString();
    const duration = Date.now() - startedAt;
    const details = await readSafeSupabaseError(response);
    if (!Object.hasOwn(OBSERVED_RPCS, rpc) || count >= MAX_EVENTS) return details;
    count += 1;
    try {
      const diagnostic = sanitizeBackendDiagnostic({
        event: DIAGNOSTIC_EVENT, schema_version: 1, rpc, client, key_kind: keyKind,
        status: response.status, attempt, ...details,
        sb_gateway_version: response.headers.get('sb-gateway-version'),
        x_sb_error_code: response.headers.get('x-sb-error-code'),
        sb_request_id: response.headers.get('sb-request-id'), request_id: response.headers.get('x-request-id'),
        cf_ray: response.headers.get('cf-ray'), received_at: receivedAt, duration_ms: duration,
      });
      if (diagnostic) emit(JSON.stringify(diagnostic));
    } catch { /* Logging cannot change the caller's result or retry policy. */ }
    return details;
  };
}

export const __testing = Object.freeze({ MAX_BYTES, TIMEOUT_MS, MAX_EVENTS });