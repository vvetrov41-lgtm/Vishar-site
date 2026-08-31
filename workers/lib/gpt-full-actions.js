// Extended artist-scoped operational CRM route mapper for private GPT Actions.
//
// This module returns only named RPC descriptors. It never accepts artist_id,
// integration routing, SQL or arbitrary RPC names from the caller.

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

const ENQUIRY_STATUS = new Set([
  'new', 'reviewing', 'waiting_for_client', 'accepted', 'declined',
  'quote_sent', 'deposit_requested', 'deposit_paid', 'converted', 'closed',
]);
const PROJECT_STATUS = new Set(['draft', 'active', 'on_hold', 'completed', 'cancelled']);
const DEPOSIT_STATUS = new Set(['not_required', 'requested', 'paid', 'refunded', 'forfeited']);
const FOLLOW_UP_STATUS = new Set(['open', 'done', 'cancelled']);
const APPOINTMENT_STATUS = new Set(['draft', 'proposed', 'confirmed', 'completed', 'cancelled', 'no_show']);
const AVAILABILITY_KIND = new Set(['day_off', 'holiday', 'personal', 'other']);
const PAYMENT_REQUEST_STATUS = new Set(['pending', 'partially_paid', 'paid', 'cancelled', 'expired']);
const COMMUNICATION_CHANNEL = new Set(['whatsapp', 'instagram']);
const COMMUNICATION_LINK_STATE = new Set(['unmatched', 'linked']);
const COMMUNICATION_STATE = new Set(['open', 'archived']);

function exactObject(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid_json_object');
  for (const forbidden of ['artist_id', 'oauth_client_id', 'integration_key', 'sql', 'query', 'rpc']) {
    if (Object.prototype.hasOwnProperty.call(value, forbidden)) throw new Error(`forbidden_field:${forbidden}`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`unexpected_field:${unexpected[0]}`);
  return value;
}

function exactSearch(searchParams, allowed) {
  for (const key of searchParams.keys()) {
    if (['artist_id', 'oauth_client_id', 'integration_key', 'sql', 'rpc'].includes(key)) {
      throw new Error(`forbidden_field:${key}`);
    }
    if (!allowed.includes(key)) throw new Error(`unexpected_field:${key}`);
  }
}

function string(value, name, { required = false, max = 4000 } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`required_field:${name}`);
    return null;
  }
  if (typeof value !== 'string' || value.length > max) throw new Error(`invalid_field:${name}`);
  if (required && value.trim() === '') throw new Error(`required_field:${name}`);
  return value;
}

function enumValue(value, name, allowed, { required = false } = {}) {
  const parsed = string(value, name, { required, max: 80 });
  if (parsed == null) return null;
  if (!allowed.has(parsed)) throw new Error(`invalid_field:${name}`);
  return parsed;
}

function uuid(value, name, { required = false } = {}) {
  const parsed = string(value, name, { required, max: 64 });
  if (parsed == null) return null;
  if (!new RegExp(`^${UUID}$`).test(parsed)) throw new Error(`invalid_field:${name}`);
  return parsed;
}

function numberValue(value, name, { min = null, max = null, integer = false } = {}) {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`invalid_field:${name}`);
  }
  if (min != null && value < min) throw new Error(`invalid_field:${name}`);
  if (max != null && value > max) throw new Error(`invalid_field:${name}`);
  return value;
}

function booleanValue(value, name, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`invalid_field:${name}`);
  return value;
}

function queryLimit(value, name, fallback, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`invalid_field:${name}`);
  return parsed;
}

function queryBoolean(value, name, fallback = false) {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`invalid_field:${name}`);
}

function clientPayload(value) {
  exactObject(value, ['full_name', 'email', 'phone', 'instagram', 'preferred_contact', 'travelling_from']);
  const result = {};
  if ('full_name' in value) result.full_name = string(value.full_name, 'full_name', { max: 160 });
  if ('email' in value) result.email = string(value.email, 'email', { max: 320 });
  if ('phone' in value) result.phone = string(value.phone, 'phone', { max: 80 });
  if ('instagram' in value) result.instagram = string(value.instagram, 'instagram', { max: 80 });
  if ('preferred_contact' in value) result.preferred_contact = string(value.preferred_contact, 'preferred_contact', { max: 40 });
  if ('travelling_from' in value) result.travelling_from = string(value.travelling_from, 'travelling_from', { max: 160 });
  return result;
}

function enquiryPayload(value) {
  exactObject(value, ['project_type', 'placement', 'approximate_size', 'cover_up', 'preferred_timing', 'idea']);
  const result = {};
  if ('project_type' in value) result.project_type = string(value.project_type, 'project_type', { max: 100 });
  if ('placement' in value) result.placement = string(value.placement, 'placement', { max: 160 });
  if ('approximate_size' in value) result.approximate_size = string(value.approximate_size, 'approximate_size', { max: 120 });
  if ('cover_up' in value) result.cover_up = string(value.cover_up, 'cover_up', { max: 40 });
  if ('preferred_timing' in value) result.preferred_timing = string(value.preferred_timing, 'preferred_timing', { max: 160 });
  if ('idea' in value) result.idea = string(value.idea, 'idea', { max: 4000 });
  return result;
}

export function routeForFullGptAction(request, url, body) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let match;

  match = new RegExp(`^/v1/clients/(${UUID})$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_get_client', payload: { p_client_id: match[1] }, responseKind: 'single-row', notFoundError: 'client_not_found' };
  }
  if (match && method === 'PATCH') {
    const patch = clientPayload(body);
    if (Object.keys(patch).length === 0) throw new Error('required_field:client');
    return { rpc: 'gpt_update_client', payload: { p_client_id: match[1], p_client: patch }, responseKind: 'object' };
  }

  if (method === 'POST' && path === '/v1/enquiries/manual') {
    exactObject(body, ['request_id', 'client', 'enquiry', 'privacy_acknowledged']);
    const client = clientPayload(body.client);
    const enquiry = enquiryPayload(body.enquiry);
    if (!client.full_name || !client.email) throw new Error('required_field:client');
    if (booleanValue(body.privacy_acknowledged, 'privacy_acknowledged') !== true) {
      throw new Error('invalid_field:privacy_acknowledged');
    }
    return {
      rpc: 'gpt_create_manual_enquiry',
      payload: {
        p_idempotency_key: uuid(body.request_id, 'request_id', { required: true }),
        p_client: client,
        p_enquiry: enquiry,
        p_privacy_acknowledged: true,
      },
      responseKind: 'object',
    };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/full$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_get_enquiry_full', payload: { p_enquiry_id: match[1] }, responseKind: 'single-row', notFoundError: 'enquiry_not_found' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})$`).exec(path);
  if (match && method === 'PATCH') {
    const patch = enquiryPayload(body);
    if (Object.keys(patch).length === 0) throw new Error('required_field:enquiry');
    return { rpc: 'gpt_update_enquiry', payload: { p_enquiry_id: match[1], p_enquiry: patch }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/status$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['status']);
    return { rpc: 'gpt_set_enquiry_status', payload: { p_enquiry_id: match[1], p_status: enumValue(body.status, 'status', ENQUIRY_STATUS, { required: true }) }, responseKind: 'object' };
  }

  if (method === 'GET' && path === '/v1/staff') {
    exactSearch(url.searchParams, []);
    return { rpc: 'gpt_list_artist_staff', payload: {}, responseKind: 'list' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/assign$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['profile_id']);
    return { rpc: 'gpt_assign_enquiry', payload: { p_enquiry_id: match[1], p_profile_id: uuid(body.profile_id, 'profile_id', { required: true }) }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/convert$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['title', 'description']);
    return { rpc: 'gpt_convert_enquiry_to_project', payload: { p_enquiry_id: match[1], p_title: string(body.title, 'title', { required: true, max: 200 }), p_description: string(body.description, 'description', { max: 4000 }) }, responseKind: 'object' };
  }

  if (method === 'GET' && path === '/v1/projects') {
    exactSearch(url.searchParams, ['status', 'limit']);
    return { rpc: 'gpt_list_projects', payload: { p_status: enumValue(url.searchParams.get('status'), 'status', PROJECT_STATUS), p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 20, 25) }, responseKind: 'list' };
  }

  match = new RegExp(`^/v1/projects/(${UUID})$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_get_project', payload: { p_project_id: match[1] }, responseKind: 'single-row', notFoundError: 'project_not_found' };
  }
  if (match && method === 'PATCH') {
    exactObject(body, ['title', 'description']);
    if (!('title' in body) && !('description' in body)) throw new Error('required_field:project');
    return { rpc: 'gpt_update_project_details', payload: { p_project_id: match[1], p_title: 'title' in body ? string(body.title, 'title', { max: 200 }) : null, p_description: 'description' in body ? string(body.description, 'description', { max: 4000 }) : null }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/projects/(${UUID})/status$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['status']);
    return { rpc: 'gpt_set_project_status', payload: { p_project_id: match[1], p_status: enumValue(body.status, 'status', PROJECT_STATUS, { required: true }) }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/projects/(${UUID})/finance$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_get_project_finance', payload: { p_project_id: match[1] }, responseKind: 'single-row', notFoundError: 'project_not_found' };
  }

  match = new RegExp(`^/v1/projects/(${UUID})/estimate$`).exec(path);
  if (match && method === 'PATCH') {
    exactObject(body, ['hourly_rate', 'estimate_total', 'estimated_sessions', 'estimated_hours', 'currency']);
    return { rpc: 'gpt_update_project_estimate', payload: {
      p_project_id: match[1],
      p_hourly_rate: numberValue(body.hourly_rate, 'hourly_rate', { min: 0, max: 100000 }),
      p_estimate_total: numberValue(body.estimate_total, 'estimate_total', { min: 0, max: 10000000 }),
      p_estimated_sessions: numberValue(body.estimated_sessions, 'estimated_sessions', { min: 0, max: 1000, integer: true }),
      p_estimated_hours: numberValue(body.estimated_hours, 'estimated_hours', { min: 0, max: 10000 }),
      p_currency: string(body.currency, 'currency', { max: 3 }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/projects/(${UUID})/deposit$`).exec(path);
  if (match && method === 'PATCH') {
    exactObject(body, ['amount', 'status', 'currency']);
    return { rpc: 'gpt_update_project_deposit', payload: {
      p_project_id: match[1],
      p_deposit_amount: numberValue(body.amount, 'amount', { min: 0, max: 100000 }),
      p_deposit_status: enumValue(body.status, 'status', DEPOSIT_STATUS, { required: true }),
      p_currency: string(body.currency, 'currency', { max: 3 }),
    }, responseKind: 'object' };
  }

  if (method === 'GET' && path === '/v1/notes') {
    exactSearch(url.searchParams, ['client_id', 'enquiry_id', 'project_id', 'session_id', 'limit']);
    return { rpc: 'gpt_list_internal_notes', payload: {
      p_client_id: uuid(url.searchParams.get('client_id'), 'client_id'),
      p_enquiry_id: uuid(url.searchParams.get('enquiry_id'), 'enquiry_id'),
      p_project_id: uuid(url.searchParams.get('project_id'), 'project_id'),
      p_session_id: uuid(url.searchParams.get('session_id'), 'session_id'),
      p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 20, 50),
    }, responseKind: 'list' };
  }

  if (method === 'POST' && path === '/v1/notes') {
    exactObject(body, ['body', 'client_id', 'enquiry_id', 'project_id', 'session_id']);
    return { rpc: 'gpt_create_internal_note', payload: {
      p_body: string(body.body, 'body', { required: true, max: 8000 }),
      p_client_id: uuid(body.client_id, 'client_id'),
      p_enquiry_id: uuid(body.enquiry_id, 'enquiry_id'),
      p_project_id: uuid(body.project_id, 'project_id'),
      p_session_id: uuid(body.session_id, 'session_id'),
    }, responseKind: 'object' };
  }

  if (method === 'GET' && path === '/v1/follow-ups') {
    exactSearch(url.searchParams, ['status', 'from', 'to', 'limit']);
    return { rpc: 'gpt_list_follow_ups', payload: {
      p_status: enumValue(url.searchParams.get('status'), 'status', FOLLOW_UP_STATUS),
      p_from: string(url.searchParams.get('from'), 'from', { max: 64 }),
      p_to: string(url.searchParams.get('to'), 'to', { max: 64 }),
      p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 20, 50),
    }, responseKind: 'list' };
  }

  if (method === 'POST' && path === '/v1/follow-ups') {
    exactObject(body, ['subject', 'due_at', 'client_id', 'enquiry_id', 'project_id', 'assigned_to', 'details']);
    return { rpc: 'gpt_create_follow_up', payload: {
      p_subject: string(body.subject, 'subject', { required: true, max: 300 }),
      p_due_at: string(body.due_at, 'due_at', { required: true, max: 64 }),
      p_client_id: uuid(body.client_id, 'client_id'),
      p_enquiry_id: uuid(body.enquiry_id, 'enquiry_id'),
      p_project_id: uuid(body.project_id, 'project_id'),
      p_assigned_to: uuid(body.assigned_to, 'assigned_to'),
      p_details: string(body.details, 'details', { max: 4000 }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/follow-ups/(${UUID})/(complete|cancel)$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, []);
    return { rpc: match[2] === 'complete' ? 'gpt_complete_follow_up' : 'gpt_cancel_follow_up', payload: { p_follow_up_id: match[1] }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/appointments/(${UUID})/full$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_get_appointment_full', payload: { p_appointment_id: match[1] }, responseKind: 'single-row', notFoundError: 'appointment_not_found' };
  }

  match = new RegExp(`^/v1/appointments/(${UUID})/status$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['status']);
    return { rpc: 'gpt_set_appointment_status', payload: { p_appointment_id: match[1], p_status: enumValue(body.status, 'status', APPOINTMENT_STATUS, { required: true }) }, responseKind: 'object' };
  }

  if (method === 'GET' && path === '/v1/availability') {
    exactSearch(url.searchParams, ['from', 'to', 'include_cancelled']);
    return { rpc: 'gpt_list_availability_blocks', payload: {
      p_from: string(url.searchParams.get('from'), 'from', { required: true, max: 64 }),
      p_to: string(url.searchParams.get('to'), 'to', { required: true, max: 64 }),
      p_include_cancelled: queryBoolean(url.searchParams.get('include_cancelled'), 'include_cancelled', false),
    }, responseKind: 'list' };
  }

  if (method === 'POST' && path === '/v1/availability') {
    exactObject(body, ['block_kind', 'start_at', 'end_at', 'is_all_day', 'note']);
    return { rpc: 'gpt_create_availability_block', payload: {
      p_block_kind: enumValue(body.block_kind, 'block_kind', AVAILABILITY_KIND, { required: true }),
      p_start_at: string(body.start_at, 'start_at', { required: true, max: 64 }),
      p_end_at: string(body.end_at, 'end_at', { required: true, max: 64 }),
      p_is_all_day: booleanValue(body.is_all_day, 'is_all_day', false),
      p_note: string(body.note, 'note', { max: 500 }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/availability/(${UUID})$`).exec(path);
  if (match && method === 'PATCH') {
    exactObject(body, ['block_kind', 'start_at', 'end_at', 'is_all_day', 'note']);
    return { rpc: 'gpt_update_availability_block', payload: {
      p_block_id: match[1],
      p_block_kind: enumValue(body.block_kind, 'block_kind', AVAILABILITY_KIND, { required: true }),
      p_start_at: string(body.start_at, 'start_at', { required: true, max: 64 }),
      p_end_at: string(body.end_at, 'end_at', { required: true, max: 64 }),
      p_is_all_day: booleanValue(body.is_all_day, 'is_all_day', false),
      p_note: string(body.note, 'note', { max: 500 }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/availability/(${UUID})/cancel$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, []);
    return { rpc: 'gpt_cancel_availability_block', payload: { p_block_id: match[1] }, responseKind: 'object' };
  }

  if (method === 'GET' && path === '/v1/payments/requests') {
    exactSearch(url.searchParams, ['status', 'limit']);
    return { rpc: 'gpt_list_payment_requests', payload: {
      p_status: enumValue(url.searchParams.get('status'), 'status', PAYMENT_REQUEST_STATUS),
      p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 20, 50),
    }, responseKind: 'list' };
  }

  match = new RegExp(`^/v1/appointments/(${UUID})/deposit-request$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['request_id', 'delivery_channel']);
    return { rpc: 'gpt_request_session_deposit', payload: {
      p_session_id: match[1],
      p_idempotency_key: uuid(body.request_id, 'request_id', { required: true }),
      p_delivery_channel: string(body.delivery_channel, 'delivery_channel', { max: 40 }) || 'email',
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/payments/requests/(${UUID})/cancel$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, []);
    return { rpc: 'gpt_cancel_payment_request', payload: { p_payment_request_id: match[1] }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/payments/requests/(${UUID})/manual-payment$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['request_id', 'amount', 'occurred_at', 'safe_note_code']);
    return { rpc: 'gpt_record_manual_payment', payload: {
      p_payment_request_id: match[1],
      p_idempotency_key: uuid(body.request_id, 'request_id', { required: true }),
      p_amount: numberValue(body.amount, 'amount', { min: 0.01, max: 10000000 }),
      p_occurred_at: string(body.occurred_at, 'occurred_at', { max: 64 }),
      p_safe_note_code: string(body.safe_note_code, 'safe_note_code', { max: 120 }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/whatsapp$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_get_whatsapp_conversation_for_enquiry', payload: { p_enquiry_id: match[1] }, responseKind: 'single-row', notFoundError: 'whatsapp_conversation_not_found' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/whatsapp/ensure$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, []);
    return { rpc: 'gpt_ensure_whatsapp_conversation', payload: { p_enquiry_id: match[1] }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/whatsapp/conversations/(${UUID})/messages$`).exec(path);
  if (match && method === 'GET') {
    exactSearch(url.searchParams, ['limit']);
    return { rpc: 'gpt_list_whatsapp_messages', payload: { p_conversation_id: match[1], p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 20, 50) }, responseKind: 'list' };
  }
  if (match && method === 'POST') {
    exactObject(body, ['body', 'request_id']);
    return { rpc: 'gpt_send_whatsapp_message', payload: { p_conversation_id: match[1], p_body: string(body.body, 'body', { required: true, max: 4000 }), p_request_id: uuid(body.request_id, 'request_id', { required: true }) }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/emails$`).exec(path);
  if (match && method === 'GET') {
    exactSearch(url.searchParams, ['limit']);
    return { rpc: 'gpt_list_email_messages', payload: { p_enquiry_id: match[1], p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 20, 50) }, responseKind: 'list' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/emails/drafts$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['subject', 'body']);
    return { rpc: 'gpt_create_email_draft', payload: { p_enquiry_id: match[1], p_subject: string(body.subject, 'subject', { required: true, max: 300 }), p_body: string(body.body, 'body', { required: true, max: 8000 }) }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/emails/(${UUID})/approve$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, []);
    return { rpc: 'gpt_approve_email_draft', payload: { p_email_message_id: match[1] }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/enquiries/(${UUID})/files$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_list_enquiry_files', payload: { p_enquiry_id: match[1] }, responseKind: 'list' };
  }

  match = new RegExp(`^/v1/projects/(${UUID})/files$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_list_project_files', payload: { p_project_id: match[1] }, responseKind: 'list' };
  }

  if (method === 'GET' && path === '/v1/activity') {
    exactSearch(url.searchParams, ['from', 'to', 'limit']);
    return { rpc: 'gpt_list_activity', payload: {
      p_from: string(url.searchParams.get('from'), 'from', { max: 64 }),
      p_to: string(url.searchParams.get('to'), 'to', { max: 64 }),
      p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 30, 50),
    }, responseKind: 'list' };
  }

  // Unified Communications inbox.
  //
  // Every route names a conversation and nothing else: the artist, channel,
  // provider account and destination are all read from the stored row on the
  // server. Inbound message bodies returned here are third-party content and
  // remain untrusted data.
  if (method === 'GET' && path === '/v1/communications/conversations') {
    exactSearch(url.searchParams, ['channel', 'link_state', 'state', 'limit', 'before']);
    return { rpc: 'gpt_list_communication_conversations', payload: {
      p_channel: enumValue(url.searchParams.get('channel'), 'channel', COMMUNICATION_CHANNEL),
      p_link_state: enumValue(url.searchParams.get('link_state'), 'link_state', COMMUNICATION_LINK_STATE),
      p_state: enumValue(url.searchParams.get('state'), 'state', COMMUNICATION_STATE),
      p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 20, 50),
      p_before: string(url.searchParams.get('before'), 'before', { max: 64 }),
    }, responseKind: 'list' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})$`).exec(path);
  if (match && method === 'GET') {
    return { rpc: 'gpt_get_communication_conversation', payload: { p_conversation_id: match[1] }, responseKind: 'single-row', notFoundError: 'conversation_not_found' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})/messages$`).exec(path);
  if (match && method === 'GET') {
    exactSearch(url.searchParams, ['limit']);
    return { rpc: 'gpt_list_communication_messages', payload: {
      p_conversation_id: match[1],
      p_limit: queryLimit(url.searchParams.get('limit'), 'limit', 30, 30),
    }, responseKind: 'list' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})/reply$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['request_id', 'body']);
    return { rpc: 'gpt_send_communication_reply', payload: {
      p_conversation_id: match[1],
      p_body: string(body.body, 'body', { required: true, max: 4000 }),
      p_request_id: uuid(body.request_id, 'request_id', { required: true }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})/read$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, []);
    return { rpc: 'gpt_mark_communication_conversation_read', payload: { p_conversation_id: match[1] }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})/state$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['state']);
    return { rpc: 'gpt_set_communication_conversation_state', payload: {
      p_conversation_id: match[1],
      p_state: enumValue(body.state, 'state', COMMUNICATION_STATE, { required: true }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})/link-client$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['client_id']);
    return { rpc: 'gpt_link_communication_conversation_client', payload: {
      p_conversation_id: match[1],
      p_client_id: uuid(body.client_id, 'client_id', { required: true }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})/client$`).exec(path);
  if (match && method === 'POST') {
    // Narrower than the manual-intake client payload: the underlying CRM
    // contract accepts exactly these four canonical identity fields.
    exactObject(body, ['full_name', 'email', 'phone', 'instagram']);
    return { rpc: 'gpt_create_client_from_communication', payload: {
      p_conversation_id: match[1],
      p_full_name: string(body.full_name, 'full_name', { required: true, max: 160 }),
      p_email: string(body.email, 'email', { max: 320 }),
      p_phone: string(body.phone, 'phone', { max: 80 }),
      p_instagram: string(body.instagram, 'instagram', { max: 80 }),
    }, responseKind: 'object' };
  }

  match = new RegExp(`^/v1/communications/conversations/(${UUID})/enquiry$`).exec(path);
  if (match && method === 'POST') {
    exactObject(body, ['request_id', 'client', 'enquiry', 'privacy_acknowledged']);
    const client = clientPayload(body.client);
    const enquiry = enquiryPayload(body.enquiry);
    if (!client.full_name || !client.email) throw new Error('required_field:client');
    if (booleanValue(body.privacy_acknowledged, 'privacy_acknowledged') !== true) {
      throw new Error('invalid_field:privacy_acknowledged');
    }
    return { rpc: 'gpt_create_enquiry_from_communication', payload: {
      p_conversation_id: match[1],
      p_idempotency_key: uuid(body.request_id, 'request_id', { required: true }),
      p_client: client,
      p_enquiry: enquiry,
      p_privacy_acknowledged: true,
    }, responseKind: 'object' };
  }

  return null;
}

export const __testing = Object.freeze({
  exactObject,
  clientPayload,
  enquiryPayload,
  routeForFullGptAction,
});
