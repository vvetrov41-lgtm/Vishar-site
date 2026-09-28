import { resolveProviderBinding, ProviderRouteError } from './provider-routing.js';
import { createSupabaseClient } from './supabase.js';
import { GRAPH_API_VERSION } from './whatsapp.js';

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2}(?:_[A-Z]{2})?$/;
const PROVIDER_ID = /^[0-9]{5,32}$/;
const SAFE_STATUS = /^[A-Z][A-Z_]{2,31}$/;
const MAX_TARGETS = 5;

const TATTOO_BODY = [
  'Hi {{1}}, your tattoo session is booked ✅',
  'Artist: {{2}}',
  'When: {{3}} at {{4}}',
  'Deposit paid: {{5}} ✅',
  'Remaining balance: {{6}}',
  '',
  'Please confirm so I know to expect you.',
].join('\n');

const CONSULTATION_BODY = [
  'Hi {{1}}, your consultation is booked ✅',
  'Artist: {{2}}',
  'When: {{3}} at {{4}}',
  '',
  'Please confirm so I know to expect you.',
].join('\n');

function safeErrorCode(error) {
  const value = error instanceof ProviderRouteError ? error.code : error?.code;
  return typeof value === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(value)
    ? value
    : 'whatsapp_template_maintenance_failed';
}

function targetRoute(target) {
  if (
    !UUID.test(target?.artist_id ?? '')
    || !INTEGRATION_KEY.test(target?.integration_key ?? '')
    || !TEMPLATE_NAME.test(target?.tattoo_template_name ?? '')
    || !TEMPLATE_NAME.test(target?.consultation_template_name ?? '')
    || !TEMPLATE_LANGUAGE.test(target?.template_language ?? '')
  ) {
    throw Object.assign(new Error('invalid template target'), {
      code: 'whatsapp_template_target_invalid',
    });
  }
  return {
    kind: 'whatsapp_message',
    integration_type: 'whatsapp',
    provider: 'meta_cloud_api',
    integration_key: target.integration_key,
  };
}

function adminBinding(env, target) {
  const selected = resolveProviderBinding(env, targetRoute(target));
  const wabaId = typeof selected.credentials.wabaId === 'string'
    ? selected.credentials.wabaId.trim()
    : '';
  const accessToken = typeof selected.credentials.accessToken === 'string'
    ? selected.credentials.accessToken
    : '';
  if (!PROVIDER_ID.test(wabaId) || accessToken.length < 20 || /\s/.test(accessToken)) {
    throw Object.assign(new Error('invalid template provider binding'), {
      code: 'provider_binding_invalid',
    });
  }
  return { wabaId, accessToken };
}

function templateDefinition(kind, name, language) {
  const tattoo = kind === 'tattoo';
  if (!tattoo && kind !== 'consultation') {
    throw Object.assign(new Error('unsupported template kind'), {
      code: 'whatsapp_template_contract_invalid',
    });
  }
  return {
    name,
    language,
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'LOCATION' },
      {
        type: 'BODY',
        text: tattoo ? TATTOO_BODY : CONSULTATION_BODY,
        example: {
          body_text: [tattoo
            ? ['James', 'Vladimir', 'Tuesday, 10 November 2026', '10:00', '£250', '£730']
            : ['Barry', 'Vladimir', 'Friday, 6 November 2026', '11:30']],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: "I'll be there" },
          { type: 'QUICK_REPLY', text: 'Need another time' },
        ],
      },
    ],
  };
}

// Meta returns HTTP 400 for most template failures (permission #200, token
// #190, duplicate content, policy, a WABA-level template restriction), so the
// status alone cannot explain one. The numeric code, subcode and type are
// kept, plus Meta's own error message and fbtrace_id so a restriction can be
// raised with Meta support. The message is Meta's text, bounded and dropped
// if it could carry request content (a template placeholder or body line) or
// anything token-like. error_user_msg / error_user_title are never read.
const PROVIDER_ERROR_TYPE = /^[A-Za-z_]{1,64}$/;
const PROVIDER_TRACE_ID = /^[A-Za-z0-9_\-/+=]{6,64}$/;
const MAX_PROVIDER_ERROR_BYTES = 8192;
const MAX_PROVIDER_MESSAGE = 300;
const TOKEN_LIKE = /\bEA[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{40,}/;

// A WABA-level restriction on creating or updating message templates. It is
// not a missing permission: retrying every cycle cannot clear it, so the
// claim RPC waits a day between attempts while it is recorded.
export const TEMPLATE_RESTRICTION = Object.freeze({ code: 100, subcode: 2494160 });

function providerMessage(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_PROVIDER_MESSAGE) return null;
  if (text.includes('{{') || TOKEN_LIKE.test(text)) return null;
  const bodyLines = [...TATTOO_BODY.split('\n'), ...CONSULTATION_BODY.split('\n')]
    .map((line) => line.trim())
    .filter((line) => line.length > 8);
  if (bodyLines.some((line) => text.includes(line))) return null;
  return text;
}

function providerInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_000_000_000 ? value : null;
}

async function readProviderError(response) {
  const diagnostic = {
    http_status: Number.isInteger(response.status) ? response.status : null,
    code: null,
    subcode: null,
    type: null,
    message: null,
    fbtrace_id: null,
  };
  let reader;
  try {
    if (Number(response.headers?.get('content-length')) > MAX_PROVIDER_ERROR_BYTES) return diagnostic;
    reader = response.body?.getReader();
    if (!reader) return diagnostic;
    // The cap is enforced while streaming, so an oversized body is never
    // buffered whole.
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_ERROR_BYTES) return diagnostic;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const error = JSON.parse(new TextDecoder().decode(bytes))?.error;
    diagnostic.code = providerInteger(error?.code);
    diagnostic.subcode = providerInteger(error?.error_subcode);
    diagnostic.type = typeof error?.type === 'string' && PROVIDER_ERROR_TYPE.test(error.type)
      ? error.type
      : null;
    diagnostic.message = providerMessage(error?.message);
    diagnostic.fbtrace_id = typeof error?.fbtrace_id === 'string'
      && PROVIDER_TRACE_ID.test(error.fbtrace_id)
      ? error.fbtrace_id
      : null;
  } catch {
    // An unreadable body keeps the HTTP status only.
  } finally {
    try {
      reader?.cancel()?.catch(() => {});
    } catch {
      // Diagnostic only.
    }
  }
  return diagnostic;
}

async function graph(binding, path, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${GRAPH_ORIGIN}/${GRAPH_API_VERSION}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${binding.accessToken}`,
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
      redirect: 'manual',
    });
  } catch {
    throw Object.assign(new Error('Meta unreachable'), {
      code: 'whatsapp_template_provider_unreachable',
    });
  }
  if (!response.ok) {
    const providerError = await readProviderError(response);
    const code = response.status === 401 || response.status === 403
      ? 'whatsapp_template_credentials_rejected'
      : response.status === 429
        ? 'whatsapp_template_rate_limited'
        : response.status >= 500
          ? 'whatsapp_template_provider_unavailable'
          : 'whatsapp_template_rejected';
    throw Object.assign(new Error('Meta template request failed'), { code, providerError });
  }
  try {
    return await response.json();
  } catch {
    throw Object.assign(new Error('Meta response invalid'), {
      code: 'whatsapp_template_response_invalid',
    });
  }
}

async function listTemplates(binding, fetchImpl) {
  const url = new URL(`${binding.wabaId}/message_templates`, `${GRAPH_ORIGIN}/${GRAPH_API_VERSION}/`);
  url.searchParams.set('fields', 'id,name,status,language,category');
  url.searchParams.set('limit', '100');
  const relative = url.toString().replace(`${GRAPH_ORIGIN}/${GRAPH_API_VERSION}/`, '');
  const payload = await graph(binding, relative, { method: 'GET' }, fetchImpl);
  if (!Array.isArray(payload?.data)) {
    throw Object.assign(new Error('Meta template list invalid'), {
      code: 'whatsapp_template_response_invalid',
    });
  }
  return payload.data;
}

function resolveTemplate(rows, name, language) {
  const matches = rows.filter((row) => row?.name === name);
  if (matches.length === 0) return null;
  const exact = matches.filter((row) => row?.language === language);
  if (exact.length !== 1) {
    throw Object.assign(new Error('template identity ambiguous'), {
      code: 'whatsapp_template_contract_mismatch',
    });
  }
  const row = exact[0];
  if (row?.category !== 'UTILITY') {
    throw Object.assign(new Error('template category mismatch'), {
      code: 'whatsapp_template_contract_mismatch',
    });
  }
  const status = typeof row.status === 'string' ? row.status.toUpperCase() : '';
  if (!SAFE_STATUS.test(status)) {
    throw Object.assign(new Error('template status invalid'), {
      code: 'whatsapp_template_response_invalid',
    });
  }
  return status;
}

async function createTemplate(binding, definition, fetchImpl) {
  const payload = await graph(
    binding,
    `${binding.wabaId}/message_templates`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(definition),
    },
    fetchImpl,
  );
  if (typeof payload?.id !== 'string' || !payload.id) {
    throw Object.assign(new Error('Meta template creation readback invalid'), {
      code: 'whatsapp_template_response_invalid',
    });
  }
}

const HEALTH_STATE = /^[A-Z][A-Z_]{2,31}$/;
const HEALTH_ENTITY = /^[A-Z][A-Z_]{2,31}$/;
const MAX_HEALTH_ENTITIES = 6;
const MAX_HEALTH_ERRORS = 4;
const MAX_HEALTH_TEXT = 200;

function healthText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || TOKEN_LIKE.test(text)) return null;
  return text.slice(0, MAX_HEALTH_TEXT);
}

// Meta's own account health for the WABA: whether it can send, and each
// blocking entity's error code, description and suggested fix. Read-only;
// a failure here never affects template maintenance or messaging.
async function readWabaHealth(binding, fetchImpl) {
  try {
    const payload = await graph(
      binding,
      `${binding.wabaId}?fields=health_status`,
      { method: 'GET' },
      fetchImpl,
    );
    const health = payload?.health_status;
    if (!health || typeof health !== 'object') return null;
    const state = (value) => (typeof value === 'string' && HEALTH_STATE.test(value) ? value : null);
    const entities = Array.isArray(health.entities) ? health.entities : [];
    return {
      can_send_message: state(health.can_send_message),
      entities: entities.slice(0, MAX_HEALTH_ENTITIES).map((entity) => ({
        entity_type: typeof entity?.entity_type === 'string' && HEALTH_ENTITY.test(entity.entity_type)
          ? entity.entity_type
          : null,
        can_send_message: state(entity?.can_send_message),
        errors: (Array.isArray(entity?.errors) ? entity.errors : [])
          .slice(0, MAX_HEALTH_ERRORS)
          .map((error) => ({
            error_code: providerInteger(error?.error_code),
            error_description: healthText(error?.error_description),
            possible_solution: healthText(error?.possible_solution),
          })),
      })),
    };
  } catch {
    return null;
  }
}

async function atStage(stage, run) {
  try {
    return await run();
  } catch (error) {
    if (error?.providerError && !error.providerError.stage) {
      error.providerError = { stage, ...error.providerError };
    }
    throw error;
  }
}

async function ensureTargetTemplates(env, target, fetchImpl) {
  const binding = adminBinding(env, target);
  let rows = await atStage('list', () => listTemplates(binding, fetchImpl));
  let created = 0;

  const tattooName = target.tattoo_template_name;
  const consultationName = target.consultation_template_name;
  let tattooStatus = resolveTemplate(rows, tattooName, target.template_language);
  let consultationStatus = resolveTemplate(rows, consultationName, target.template_language);

  if (!tattooStatus) {
    await atStage('create_tattoo', () => createTemplate(
      binding,
      templateDefinition('tattoo', tattooName, target.template_language),
      fetchImpl,
    ));
    created += 1;
  }
  if (!consultationStatus) {
    await atStage('create_consultation', () => createTemplate(
      binding,
      templateDefinition('consultation', consultationName, target.template_language),
      fetchImpl,
    ));
    created += 1;
  }

  if (created > 0) rows = await atStage('readback', () => listTemplates(binding, fetchImpl));
  tattooStatus = resolveTemplate(rows, tattooName, target.template_language) || 'PENDING';
  consultationStatus = resolveTemplate(rows, consultationName, target.template_language) || 'PENDING';

  return { tattooStatus, consultationStatus, created };
}

export async function maintainWhatsappBookingTemplates(env, {
  limit = MAX_TARGETS,
  fetchImpl = fetch,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw Object.assign(new Error('template maintenance limit invalid'), {
      code: 'whatsapp_template_limit_invalid',
    });
  }

  const supabase = createSupabaseClient(env, fetchImpl);
  const claimed = await supabase.rpc('service_claim_booking_card_template_targets', {
    p_limit: limit,
  });
  const targets = Array.isArray(claimed) ? claimed : claimed == null ? [] : [claimed];
  if (targets.length > limit) {
    throw Object.assign(new Error('template maintenance claim invalid'), {
      code: 'whatsapp_template_claim_invalid',
    });
  }

  const summary = { targets: targets.length, checked: 0, created: 0, approved: 0, failed: 0 };
  for (const target of targets) {
    let tattooStatus = typeof target?.tattoo_template_status === 'string'
      && SAFE_STATUS.test(target.tattoo_template_status)
      ? target.tattoo_template_status
      : 'UNKNOWN';
    let consultationStatus = typeof target?.consultation_template_status === 'string'
      && SAFE_STATUS.test(target.consultation_template_status)
      ? target.consultation_template_status
      : 'UNKNOWN';
    let errorCode = null;
    let providerError = null;

    let wabaHealth = null;
    try {
      wabaHealth = await readWabaHealth(adminBinding(env, target), fetchImpl);
    } catch {
      wabaHealth = null;
    }

    try {
      const result = await ensureTargetTemplates(env, target, fetchImpl);
      tattooStatus = result.tattooStatus;
      consultationStatus = result.consultationStatus;
      summary.created += result.created;
      summary.checked += 1;
      if (tattooStatus === 'APPROVED' && consultationStatus === 'APPROVED') {
        summary.approved += 1;
      }
    } catch (error) {
      errorCode = safeErrorCode(error);
      providerError = error?.providerError ?? null;
      summary.failed += 1;
    }

    try {
      await supabase.rpc('service_record_booking_card_template_status', {
        p_artist_id: target.artist_id,
        p_tattoo_status: tattooStatus,
        p_consultation_status: consultationStatus,
        p_error_code: errorCode,
        // Sent only when Meta answered, so a success keeps the original call.
        ...(providerError ? { p_provider_error: providerError } : {}),
        ...(wabaHealth ? { p_waba_health: wabaHealth } : {}),
      });
    } catch {
      summary.failed += errorCode ? 0 : 1;
    }
  }

  return summary;
}

export const __testing = Object.freeze({
  TATTOO_BODY,
  CONSULTATION_BODY,
  adminBinding,
  resolveTemplate,
  templateDefinition,
  safeErrorCode,
  readProviderError,
  readWabaHealth,
  providerMessage,
});
