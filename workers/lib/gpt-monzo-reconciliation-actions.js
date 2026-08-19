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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_json_body' };
  }
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(field)) return { error: 'forbidden_field', field };
    if (!allowed.has(field)) return { error: 'unexpected_field', field };
  }
  return { value: body };
}

function noSearchParams(url) {
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_FIELDS.has(key)) return { error: 'forbidden_field', field: key };
    return { error: 'unexpected_query_parameter', field: key };
  }
  return { value: true };
}

export async function routeForGptMonzoReconciliationAction(request, url) {
  const method = request.method.toUpperCase();

  if (method === 'GET' && url.pathname === '/v1/payments/monzo/reconciliation') {
    const query = noSearchParams(url);
    if (query.error) return query;
    return {
      rpc: 'gpt_list_monzo_reconciliation_candidates',
      payload: {},
      responseKind: 'object',
    };
  }

  let match = url.pathname.match(/^\/v1\/payments\/monzo\/reconciliation\/([^/]+)\/match$/);
  if (method === 'POST' && match) {
    const candidateId = match[1];
    if (!isUuid(candidateId)) return { error: 'invalid_candidate_id' };
    const body = exactObject(await request.json().catch(() => null), ['payment_request_id']);
    if (body.error) return body;
    if (!isUuid(body.value.payment_request_id)) return { error: 'invalid_payment_request_id' };
    return {
      rpc: 'gpt_match_monzo_reconciliation_candidate',
      payload: {
        p_candidate_id: candidateId,
        p_payment_request_id: body.value.payment_request_id,
      },
      responseKind: 'object',
    };
  }

  match = url.pathname.match(/^\/v1\/payments\/monzo\/reconciliation\/([^/]+)\/(ignore|confirm)$/);
  if (method === 'POST' && match) {
    const candidateId = match[1];
    const action = match[2];
    if (!isUuid(candidateId)) return { error: 'invalid_candidate_id' };
    const body = exactObject(await request.json().catch(() => null), []);
    if (body.error) return body;
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
