const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_FIELDS = new Set([
  'artist_id',
  'oauth_client_id',
  'integration_key',
  'provider_account_key',
  'provider_event_id',
  'provider_transaction_id',
  'sql',
  'query',
  'rpc',
]);

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function exactObject(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_json_object');
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(field)) throw new Error(`forbidden_field:${field}`);
    if (!allowed.has(field)) throw new Error(`unexpected_field:${field}`);
  }
  return body;
}

function exactSearch(url) {
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_FIELDS.has(key)) throw new Error(`forbidden_field:${key}`);
    throw new Error(`unexpected_field:${key}`);
  }
}

export function routeForGptMonzoReconciliationAction(request, url, body = {}) {
  const method = request.method.toUpperCase();

  if (method === 'GET' && url.pathname === '/v1/payments/monzo/reconciliation') {
    exactSearch(url);
    return {
      rpc: 'gpt_list_monzo_reconciliation_candidates',
      payload: {},
      responseKind: 'object',
    };
  }

  let match = url.pathname.match(/^\/v1\/payments\/monzo\/reconciliation\/([^/]+)\/match$/);
  if (method === 'POST' && match) {
    const candidateId = match[1];
    if (!isUuid(candidateId)) throw new Error('invalid_field:candidate_id');
    const parsed = exactObject(body, ['payment_request_id']);
    if (!isUuid(parsed.payment_request_id)) throw new Error('invalid_field:payment_request_id');
    return {
      rpc: 'gpt_match_monzo_reconciliation_candidate',
      payload: {
        p_candidate_id: candidateId,
        p_payment_request_id: parsed.payment_request_id,
      },
      responseKind: 'object',
    };
  }

  match = url.pathname.match(/^\/v1\/payments\/monzo\/reconciliation\/([^/]+)\/(ignore|confirm)$/);
  if (method === 'POST' && match) {
    const candidateId = match[1];
    const action = match[2];
    if (!isUuid(candidateId)) throw new Error('invalid_field:candidate_id');
    exactObject(body, []);
    return {
      rpc: action === 'ignore'
        ? 'gpt_ignore_monzo_reconciliation_candidate'
        : 'gpt_confirm_monzo_reconciliation_candidate',
      payload: { p_candidate_id: candidateId },
      responseKind: 'object',
    };
  }

  return null;
}
