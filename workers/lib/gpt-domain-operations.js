// Declarative registry of Unified GPT v2 domain operations.
//
// Each entry is one named Vishar operation: a fixed method + path mapped to one
// fixed public.gpt_* RPC with typed, exact parameters. The router below never
// accepts an RPC name, SQL, an Artist id, an OAuth client id or an integration
// key from the caller, and every RPC re-checks identity, Artist context, the
// GPT client ceiling and the human's CRM capability in the database.
//
// The same registry is the source for the unified OpenAPI projections
// (scripts/build-gpt-unified-openapi.mjs), so a route and its schema cannot
// drift apart.

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const UUID = new RegExp(`^${UUID_PATTERN}$`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const FORBIDDEN = ['artist_id', 'oauth_client_id', 'integration_key', 'sql', 'query', 'rpc', 'workspace_id'];

export const ENUMS = Object.freeze({
  appointment_type: ['tattoo_session', 'in_person_consultation', 'video_consultation', 'touch_up'],
  session_status: ['draft', 'proposed', 'confirmed', 'completed', 'cancelled', 'no_show'],
  new_session_status: ['draft', 'proposed', 'confirmed'],
  invoice_status: ['draft', 'issued', 'partially_paid', 'paid', 'void'],
  deposit_policy_mode: ['fixed', 'percentage_of_estimate'],
  deposit_delivery_channel: ['copy_link', 'email'],
});

const MONZO_PAY_URL = '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$';

// ------------------------------------------------------------ param builders
const p = {
  path: (name, arg, description) => ({ name, in: 'path', type: 'uuid', required: true, arg, description }),
  uuid: (name, arg, opts = {}) => ({ name, in: 'body', type: 'uuid', arg, ...opts }),
  text: (name, arg, max, opts = {}) => ({ name, in: 'body', type: 'string', arg, max, ...opts }),
  clock: (name, arg, opts = {}) => ({ name, in: 'body', type: 'clock', arg, ...opts }),
  int: (name, arg, min, max, opts = {}) => ({ name, in: 'body', type: 'integer', arg, min, max, ...opts }),
  num: (name, arg, min, max, opts = {}) => ({ name, in: 'body', type: 'number', arg, min, max, ...opts }),
  bool: (name, arg, opts = {}) => ({ name, in: 'body', type: 'boolean', arg, ...opts }),
  date: (name, arg, opts = {}) => ({ name, in: 'body', type: 'date', arg, ...opts }),
  dateTime: (name, arg, opts = {}) => ({ name, in: 'body', type: 'date-time', arg, ...opts }),
  enum: (name, arg, values, opts = {}) => ({ name, in: 'body', type: 'enum', arg, values, ...opts }),
  clockList: (name, arg, maxItems, opts = {}) => ({ name, in: 'body', type: 'clock-array', arg, maxItems, ...opts }),
  uuidList: (name, arg, maxItems, opts = {}) => ({ name, in: 'body', type: 'uuid-array', arg, maxItems, ...opts }),
  query: (param) => ({ ...param, in: 'query' }),
  req: (param) => ({ ...param, required: true }),
};

function op(definition) {
  const entry = { consequential: definition.method !== 'GET', params: [], ...definition };
  if (!/^gpt_[a-z0-9_]+$/.test(entry.rpc)) throw new Error(`${entry.id}: RPC must be a named gpt_ wrapper`);
  return Object.freeze({ ...entry, params: Object.freeze(entry.params.map((param) => Object.freeze(param))) });
}

const requestId = p.req(p.uuid('request_id', 'p_request_id', {
  description: 'Fresh UUID for this intended action. Reuse it only to retry the identical request.',
}));

export const DOMAIN_OPERATIONS = Object.freeze([
  // ---------------------------------------------------------------- CRM Core
  op({
    id: 'listMyCapabilities', domain: 'CRM Core', method: 'GET', path: '/v1/me/capabilities',
    rpc: 'gpt_list_my_capabilities',
    summary: 'List what the signed-in CRM user may do for the active artist',
    description: 'The CRM capability list for the active artist. It explains a permission refusal; it never grants anything.',
  }),
  op({
    id: 'getTodayPulse', domain: 'CRM Core', method: 'GET', path: '/v1/today', rpc: 'gpt_get_today_pulse',
    summary: 'Read the Today view: what needs the artist now, ranked by the CRM',
  }),
  op({
    id: 'archiveClient', domain: 'CRM Core', method: 'POST', path: '/v1/clients/{client_id}/archive',
    rpc: 'gpt_archive_client', params: [p.path('client_id', 'p_client_id')],
    summary: 'Archive a client that only this artist works with',
    description: 'Archives the client and their open enquiries exactly as the CRM Archive button does. A client shared with another artist must be archived in the CRM.',
  }),
  op({
    id: 'getClientAiState', domain: 'CRM Core', method: 'GET', path: '/v1/clients/{client_id}/ai-state',
    rpc: 'gpt_get_client_ai_state', params: [p.path('client_id', 'p_client_id')],
    summary: 'Read the CRM AI brief and recommended next action for a client',
  }),
  op({
    id: 'archiveEnquiry', domain: 'CRM Core', method: 'POST', path: '/v1/enquiries/{enquiry_id}/archive',
    rpc: 'gpt_archive_enquiry', params: [p.path('enquiry_id', 'p_enquiry_id')],
    summary: 'Archive an enquiry',
  }),
  op({
    id: 'getEnquiryAiResult', domain: 'CRM Core', method: 'GET', path: '/v1/enquiries/{enquiry_id}/ai-result',
    rpc: 'gpt_get_enquiry_ai_result', params: [p.path('enquiry_id', 'p_enquiry_id')],
    summary: 'Read the AI intake analysis of an enquiry',
  }),
  op({
    id: 'retryEnquiryAi', domain: 'CRM Core', method: 'POST', path: '/v1/enquiries/{enquiry_id}/ai-retry',
    rpc: 'gpt_retry_enquiry_ai', params: [p.path('enquiry_id', 'p_enquiry_id')],
    summary: 'Queue the AI intake analysis of an enquiry again',
  }),

  // ---------------------------------------------------------------- Projects
  op({
    id: 'removeEnquiryFile', domain: 'Projects', method: 'POST', path: '/v1/files/{file_id}/remove',
    rpc: 'gpt_remove_enquiry_file', params: [p.path('file_id', 'p_file_id')],
    summary: 'Remove a reference file from an enquiry',
  }),

  // -------------------------------------------------------------- Scheduling
  op({
    id: 'scheduleAppointmentWithPrice', domain: 'Scheduling', method: 'POST', path: '/v1/appointments/priced',
    rpc: 'gpt_schedule_appointment_with_price',
    params: [
      requestId,
      p.req(p.uuid('client_id', 'p_client_id')),
      p.req(p.enum('appointment_type', 'p_appointment_type', ENUMS.appointment_type)),
      p.req(p.dateTime('start_at', 'p_start_at')),
      p.req(p.dateTime('end_at', 'p_end_at')),
      p.req(p.num('price', 'p_price', 0, 100000)),
      p.enum('status', 'p_status', ENUMS.new_session_status, { default: 'proposed' }),
      p.uuid('enquiry_id', 'p_enquiry_id'),
      p.uuid('project_id', 'p_project_id'),
      p.text('notes', 'p_notes', 4000),
    ],
    summary: 'Schedule an appointment with an agreed price in one step',
  }),
  op({
    id: 'setAppointmentPrice', domain: 'Scheduling', method: 'POST', path: '/v1/appointments/{appointment_id}/price',
    rpc: 'gpt_set_appointment_price',
    params: [p.path('appointment_id', 'p_appointment_id'), p.req(p.num('price', 'p_price', 0, 100000))],
    summary: 'Set the agreed price of an appointment',
  }),
  op({
    id: 'checkBookingConflicts', domain: 'Scheduling', method: 'GET', path: '/v1/scheduling/booking-conflicts',
    rpc: 'gpt_list_booking_conflicts',
    params: [
      p.query(p.req(p.enum('appointment_type', 'p_appointment_type', ENUMS.appointment_type))),
      p.query(p.req(p.dateTime('start_at', 'p_start_at'))),
      p.query(p.req(p.dateTime('end_at', 'p_end_at'))),
      p.query(p.uuid('exclude_appointment_id', 'p_exclude_appointment_id')),
    ],
    summary: 'Check a proposed booking against appointments, time off and working-hour rules',
  }),
  op({
    id: 'scheduleProjectSession', domain: 'Scheduling', method: 'POST', path: '/v1/projects/{project_id}/sessions',
    rpc: 'gpt_schedule_project_session',
    params: [
      p.path('project_id', 'p_project_id'),
      requestId,
      p.req(p.dateTime('start_at', 'p_start_at')),
      p.req(p.dateTime('end_at', 'p_end_at')),
      p.enum('status', 'p_status', ENUMS.new_session_status, { default: 'proposed' }),
      p.text('notes', 'p_notes', 4000),
    ],
    summary: 'Add a tattoo session to a project',
  }),
  op({
    id: 'setProjectSessionStatus', domain: 'Scheduling', method: 'POST', path: '/v1/sessions/{session_id}/status',
    rpc: 'gpt_set_project_session_status',
    params: [p.path('session_id', 'p_session_id'), p.req(p.enum('status', 'p_status', ENUMS.session_status))],
    summary: 'Change the status of a project session (confirm, complete, cancel, no-show)',
  }),
  op({
    id: 'getSessionBookingCardStatus', domain: 'Scheduling', method: 'GET', path: '/v1/sessions/{session_id}/booking-card',
    rpc: 'gpt_get_session_booking_card_status', params: [p.path('session_id', 'p_session_id')],
    summary: 'Read whether the client booking card for a session was sent and answered',
  }),
  op({
    id: 'getSchedulingPreferences', domain: 'Scheduling', method: 'GET', path: '/v1/scheduling/preferences',
    rpc: 'gpt_get_scheduling_preferences',
    summary: 'Read the artist working hours and consultation rules',
  }),
  op({
    id: 'setSchedulingPreferences', domain: 'Scheduling', method: 'PUT', path: '/v1/scheduling/preferences',
    rpc: 'gpt_set_scheduling_preferences',
    params: [
      p.req(p.clock('tattoo_earliest_start', 'p_tattoo_earliest_start')),
      p.req(p.clock('tattoo_latest_finish', 'p_tattoo_latest_finish')),
      p.req(p.clockList('tattoo_preferred_starts', 'p_tattoo_preferred_starts', 12)),
      p.req(p.clock('consultation_earliest_start', 'p_consultation_earliest_start')),
      p.req(p.clock('consultation_latest_finish', 'p_consultation_latest_finish')),
      p.req(p.bool('consultation_during_tattoo', 'p_consultation_during_tattoo')),
      p.req(p.int('max_concurrent_consultations', 'p_max_concurrent_consultations', 0, 10)),
    ],
    summary: 'Replace the artist working hours and consultation rules',
    description: 'Send every field: read the current preferences first and change only what the user asked for.',
  }),
  op({
    id: 'listScheduleOverrides', domain: 'Scheduling', method: 'GET', path: '/v1/scheduling/overrides',
    rpc: 'gpt_list_schedule_overrides',
    params: [p.query(p.req(p.date('from', 'p_from'))), p.query(p.req(p.date('to', 'p_to')))],
    summary: 'List single-day working-hour overrides in a date range',
  }),
  op({
    id: 'setScheduleOverride', domain: 'Scheduling', method: 'POST', path: '/v1/scheduling/overrides',
    rpc: 'gpt_set_schedule_override',
    params: [
      p.req(p.date('on_date', 'p_on_date')),
      p.clock('tattoo_earliest_start', 'p_tattoo_earliest_start'),
      p.clock('tattoo_latest_finish', 'p_tattoo_latest_finish'),
      p.text('note', 'p_note', 500),
    ],
    summary: 'Set or clear the working hours of one day',
    description: 'Omit both times to clear the override for that day.',
  }),
  op({
    id: 'getSessionPricing', domain: 'Scheduling', method: 'GET', path: '/v1/scheduling/pricing',
    rpc: 'gpt_get_session_pricing',
    summary: 'Read the artist hourly, full-day and session deposit prices',
  }),
  op({
    id: 'setSessionPricing', domain: 'Scheduling', method: 'PUT', path: '/v1/scheduling/pricing',
    rpc: 'gpt_set_session_pricing',
    params: [
      p.req(p.num('hourly_rate', 'p_hourly_rate', 0, 100000)),
      p.req(p.num('full_day_rate', 'p_full_day_rate', 0, 100000)),
      p.req(p.num('full_day_hours', 'p_full_day_hours', 0, 24)),
      p.req(p.num('session_deposit_amount', 'p_session_deposit_amount', 0, 100000)),
      p.text('currency', 'p_currency', 3, { default: 'GBP', pattern: '^[A-Z]{3}$', example: 'GBP' }),
    ],
    summary: 'Replace the artist session prices and default session deposit',
    description: 'Money setting. Read the current prices first and send the exact values the user confirmed.',
  }),

  // --------------------------------------------------------- Project Finance
  op({
    id: 'getDepositPolicy', domain: 'Project Finance', method: 'GET', path: '/v1/finance/deposit-policy',
    rpc: 'gpt_get_deposit_policy',
    summary: 'Read the artist default project deposit policy',
  }),
  op({
    id: 'configureDepositPolicy', domain: 'Project Finance', method: 'PUT', path: '/v1/finance/deposit-policy',
    rpc: 'gpt_configure_deposit_policy',
    params: [
      p.req(p.enum('mode', 'p_mode', ENUMS.deposit_policy_mode)),
      p.num('fixed_amount', 'p_fixed_amount', 0.01, 100000),
      p.num('percentage', 'p_percentage', 0.01, 100),
      p.num('minimum_amount', 'p_minimum_amount', 0, 100000),
      p.num('rounding_step', 'p_rounding_step', 0.01, 1000, { default: 1 }),
    ],
    summary: 'Replace the artist default project deposit policy',
    description: 'Money setting. fixed needs fixed_amount; percentage_of_estimate needs percentage. Only send values the user confirmed.',
  }),
  op({
    id: 'previewProjectDeposit', domain: 'Project Finance', method: 'GET', path: '/v1/projects/{project_id}/deposit-preview',
    rpc: 'gpt_preview_project_deposit', params: [p.path('project_id', 'p_project_id')],
    summary: 'Preview the deposit the policy gives for a project before requesting it',
  }),
  op({
    id: 'setProjectDepositOverride', domain: 'Project Finance', method: 'POST', path: '/v1/projects/{project_id}/deposit-override',
    rpc: 'gpt_set_project_deposit_override',
    params: [p.path('project_id', 'p_project_id'), p.num('amount', 'p_amount', 0.01, 100000)],
    summary: 'Set or clear a one-project deposit amount that overrides the policy',
    description: 'Omit amount to clear the override and return to the policy.',
  }),
  op({
    id: 'requestProjectDeposit', domain: 'Project Finance', method: 'POST', path: '/v1/projects/{project_id}/deposit-request',
    rpc: 'gpt_request_project_deposit',
    params: [
      p.path('project_id', 'p_project_id'),
      p.req(p.uuid('idempotency_key', 'p_idempotency_key', { description: 'Fresh UUID per intended request; reuse only to retry the same request.' })),
      p.enum('delivery_channel', 'p_delivery_channel', ENUMS.deposit_delivery_channel, { default: 'copy_link' }),
    ],
    summary: 'Request the project deposit from the client',
    description: 'Money action. The server computes the amount from the policy or override; preview first and confirm with the user.',
  }),
  op({
    id: 'confirmProjectDepositManually', domain: 'Project Finance', method: 'POST', path: '/v1/projects/{project_id}/deposit-confirm',
    rpc: 'gpt_confirm_project_deposit_manually',
    params: [
      p.path('project_id', 'p_project_id'),
      p.req(p.uuid('idempotency_key', 'p_idempotency_key')),
      p.dateTime('occurred_at', 'p_occurred_at'),
    ],
    summary: 'Record that the project deposit was paid outside Vishar payments',
    description: 'Money action. Only when the user states the deposit was actually received.',
  }),
  op({
    id: 'requestGroupedSessionDeposit', domain: 'Project Finance', method: 'POST', path: '/v1/sessions/deposit-request',
    rpc: 'gpt_request_grouped_session_deposit',
    params: [
      p.req(p.uuidList('session_ids', 'p_session_ids', 20)),
      p.req(p.uuid('idempotency_key', 'p_idempotency_key')),
      p.enum('delivery_channel', 'p_delivery_channel', ENUMS.deposit_delivery_channel, { default: 'copy_link' }),
    ],
    summary: 'Request one deposit covering several sessions',
  }),

  // ------------------------------------------------ Billing & Reconciliation
  op({
    id: 'listInvoices', domain: 'Billing & Reconciliation', method: 'GET', path: '/v1/invoices', rpc: 'gpt_list_invoices',
    params: [
      p.query(p.uuid('project_id', 'p_project_id')),
      p.query(p.uuid('client_id', 'p_client_id')),
      p.query(p.enum('status', 'p_status', ENUMS.invoice_status)),
      p.query(p.int('limit', 'p_limit', 1, 100, { default: 50 })),
    ],
    summary: 'List invoices of the active artist',
  }),
  op({
    id: 'getInvoice', domain: 'Billing & Reconciliation', method: 'GET', path: '/v1/invoices/{invoice_id}',
    rpc: 'gpt_get_invoice', params: [p.path('invoice_id', 'p_invoice_id')],
    summary: 'Read one invoice with line items, payments, credit notes and totals',
  }),
  op({
    id: 'createInvoice', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/projects/{project_id}/invoices',
    rpc: 'gpt_create_invoice',
    params: [
      p.path('project_id', 'p_project_id'),
      p.req(p.uuid('idempotency_key', 'p_idempotency_key')),
      p.date('due_date', 'p_due_date'),
      p.text('notes', 'p_notes', 2000),
    ],
    summary: 'Create a draft invoice for a project',
  }),
  op({
    id: 'setInvoiceLineItem', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/invoices/{invoice_id}/line-items',
    rpc: 'gpt_set_invoice_line_item',
    params: [
      p.path('invoice_id', 'p_invoice_id'),
      p.req(p.text('description', 'p_description', 500)),
      p.req(p.num('quantity', 'p_quantity', 0.01, 1000)),
      p.req(p.num('unit_amount', 'p_unit_amount', 0, 100000)),
      p.uuid('line_item_id', 'p_line_item_id', { description: 'Existing line to replace; omit to add a line.' }),
      p.uuid('session_id', 'p_session_id'),
      p.int('line_position', 'p_line_position', 1, 200),
    ],
    summary: 'Add or replace a line on a draft invoice',
  }),
  op({
    id: 'removeInvoiceLineItem', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/invoice-line-items/{line_item_id}/remove',
    rpc: 'gpt_remove_invoice_line_item', params: [p.path('line_item_id', 'p_line_item_id')],
    summary: 'Remove a line from a draft invoice',
  }),
  op({
    id: 'setInvoiceDetails', domain: 'Billing & Reconciliation', method: 'PATCH', path: '/v1/invoices/{invoice_id}',
    rpc: 'gpt_set_invoice_details',
    params: [
      p.path('invoice_id', 'p_invoice_id'),
      p.date('due_date', 'p_due_date'),
      p.num('discount_amount', 'p_discount_amount', 0, 100000),
      p.text('notes', 'p_notes', 2000),
    ],
    summary: 'Change the due date, discount or notes of a draft invoice',
  }),
  op({
    id: 'issueInvoice', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/invoices/{invoice_id}/issue',
    rpc: 'gpt_issue_invoice',
    params: [p.path('invoice_id', 'p_invoice_id'), p.date('issue_date', 'p_issue_date')],
    summary: 'Issue a draft invoice, fixing its number and totals',
    description: 'Money action. Issued invoices cannot be edited; only voided or credited.',
  }),
  op({
    id: 'voidInvoice', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/invoices/{invoice_id}/void',
    rpc: 'gpt_void_invoice',
    params: [p.path('invoice_id', 'p_invoice_id'), p.req(p.text('reason', 'p_reason', 500))],
    summary: 'Void an invoice',
  }),
  op({
    id: 'attachPaymentRequestToInvoice', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/invoices/{invoice_id}/payment-requests',
    rpc: 'gpt_attach_payment_request_to_invoice',
    params: [p.path('invoice_id', 'p_invoice_id'), p.req(p.uuid('payment_request_id', 'p_payment_request_id'))],
    summary: 'Attach an existing payment request to an invoice',
  }),
  op({
    id: 'recordInvoicePayment', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/invoices/{invoice_id}/payments',
    rpc: 'gpt_record_invoice_payment',
    params: [
      p.path('invoice_id', 'p_invoice_id'),
      p.req(p.uuid('idempotency_key', 'p_idempotency_key')),
      p.req(p.num('amount', 'p_amount', 0.01, 100000)),
      p.dateTime('occurred_at', 'p_occurred_at'),
      p.text('method_code', 'p_method_code', 40),
      p.text('external_reference', 'p_external_reference', 120),
    ],
    summary: 'Record a payment received against an issued invoice',
    description: 'Money action. Only for money the user states was actually received, with the exact amount.',
  }),
  op({
    id: 'createCreditNote', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/invoices/{invoice_id}/credit-notes',
    rpc: 'gpt_create_credit_note',
    params: [
      p.path('invoice_id', 'p_invoice_id'),
      p.req(p.uuid('idempotency_key', 'p_idempotency_key')),
      p.req(p.num('amount', 'p_amount', 0.01, 100000)),
      p.req(p.text('reason', 'p_reason', 500)),
    ],
    summary: 'Credit part or all of an issued invoice',
  }),
  op({
    id: 'attachMonzoPaymentLink', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/payments/requests/{payment_request_id}/monzo-link',
    rpc: 'gpt_attach_monzo_payment_link',
    params: [
      p.path('payment_request_id', 'p_payment_request_id'),
      p.req(p.text('payment_url', 'p_payment_url', 300, { pattern: MONZO_PAY_URL, example: 'https://monzo.com/pay/r/vishar-example' })),
    ],
    summary: 'Attach a one-off Monzo payment link to an open deposit request',
  }),
  op({
    id: 'listMonzoDestinations', domain: 'Billing & Reconciliation', method: 'GET', path: '/v1/monzo/destinations',
    rpc: 'gpt_list_monzo_destinations',
    summary: 'List reusable Monzo payment links by amount',
  }),
  op({
    id: 'upsertMonzoDestination', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/monzo/destinations',
    rpc: 'gpt_upsert_monzo_destination',
    params: [
      p.req(p.num('amount', 'p_amount', 0.01, 100000)),
      p.req(p.text('payment_url', 'p_payment_url', 300, { pattern: MONZO_PAY_URL, example: 'https://monzo.com/pay/r/vishar-example' })),
    ],
    summary: 'Add or replace the reusable Monzo payment link for an amount',
  }),
  op({
    id: 'archiveMonzoDestination', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/monzo/destinations/{destination_id}/archive',
    rpc: 'gpt_archive_monzo_destination', params: [p.path('destination_id', 'p_destination_id')],
    summary: 'Archive a reusable Monzo payment link',
  }),
  op({
    id: 'getMonzoTransferSettings', domain: 'Billing & Reconciliation', method: 'GET', path: '/v1/monzo/settings',
    rpc: 'gpt_get_monzo_transfer_settings',
    summary: 'Read the Monzo Easy Bank Transfer settings',
  }),
  op({
    id: 'configureMonzoTransferSettings', domain: 'Billing & Reconciliation', method: 'PUT', path: '/v1/monzo/settings',
    rpc: 'gpt_configure_monzo_transfer_settings',
    params: [
      p.req(p.text('payment_url', 'p_payment_url', 300, { pattern: MONZO_PAY_URL, example: 'https://monzo.com/pay/r/vishar-example' })),
      p.bool('is_enabled', 'p_is_enabled', { default: false }),
    ],
    summary: 'Configure or disable Monzo Easy Bank Transfer',
  }),
  op({
    id: 'listMonzoReconciliationCandidates', domain: 'Billing & Reconciliation', method: 'GET', path: '/v1/monzo/reconciliation',
    rpc: 'gpt_list_monzo_reconciliation_candidates',
    summary: 'List incoming Monzo payments waiting to be matched to payment requests',
  }),
  op({
    id: 'matchMonzoReconciliationCandidate', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/monzo/reconciliation/{candidate_id}/match',
    rpc: 'gpt_match_monzo_reconciliation_candidate',
    params: [p.path('candidate_id', 'p_candidate_id'), p.req(p.uuid('payment_request_id', 'p_payment_request_id'))],
    summary: 'Match an incoming Monzo payment to a payment request (not yet settled)',
  }),
  op({
    id: 'ignoreMonzoReconciliationCandidate', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/monzo/reconciliation/{candidate_id}/ignore',
    rpc: 'gpt_ignore_monzo_reconciliation_candidate', params: [p.path('candidate_id', 'p_candidate_id')],
    summary: 'Mark an incoming Monzo payment as unrelated to any request',
  }),
  op({
    id: 'confirmMonzoReconciliationCandidate', domain: 'Billing & Reconciliation', method: 'POST', path: '/v1/monzo/reconciliation/{candidate_id}/confirm',
    rpc: 'gpt_confirm_monzo_reconciliation_candidate', params: [p.path('candidate_id', 'p_candidate_id')],
    summary: 'Settle a matched Monzo payment into the payment ledger',
    description: 'Money action. Confirm only after the user has checked the match.',
  }),
]);

// ------------------------------------------------------------------- router

function fail(kind, field) {
  throw new Error(field ? `${kind}:${field}` : kind);
}

function parseValue(param, raw, fromQuery) {
  let value = raw;
  if (fromQuery) {
    if (['integer', 'number'].includes(param.type)) {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) fail('invalid_field', param.name);
      value = Number(raw);
    } else if (param.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') fail('invalid_field', param.name);
      value = raw === 'true';
    }
  }

  switch (param.type) {
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_field', param.name);
      return value.toLowerCase();
    case 'string':
      if (typeof value !== 'string' || value.length > param.max) fail('invalid_field', param.name);
      if (param.pattern && !new RegExp(param.pattern).test(value)) fail('invalid_field', param.name);
      if (param.required && value.trim() === '') fail('required_field', param.name);
      return value;
    case 'clock':
      if (typeof value !== 'string' || !CLOCK.test(value)) fail('invalid_field', param.name);
      return value;
    case 'date':
      if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) fail('invalid_field', param.name);
      return value;
    case 'date-time':
      if (typeof value !== 'string' || !DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) fail('invalid_field', param.name);
      return value;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_field', param.name);
      if (param.type === 'integer' && !Number.isInteger(value)) fail('invalid_field', param.name);
      if ((param.min != null && value < param.min) || (param.max != null && value > param.max)) fail('invalid_field', param.name);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail('invalid_field', param.name);
      return value;
    case 'enum':
      if (typeof value !== 'string' || !param.values.includes(value)) fail('invalid_field', param.name);
      return value;
    case 'clock-array':
    case 'uuid-array': {
      const pattern = param.type === 'clock-array' ? CLOCK : UUID;
      if (!Array.isArray(value) || value.length > param.maxItems) fail('invalid_field', param.name);
      if (value.some((item) => typeof item !== 'string' || !pattern.test(item))) fail('invalid_field', param.name);
      return param.type === 'uuid-array' ? value.map((item) => item.toLowerCase()) : value;
    }
    default:
      throw new Error(`unknown parameter type ${param.type}`);
  }
}

function pathPattern(path) {
  return new RegExp(`^${path.replace(/\{[a-z_]+\}/g, `(${UUID_PATTERN})`)}$`);
}

const COMPILED = DOMAIN_OPERATIONS.map((entry) => ({
  entry,
  pattern: pathPattern(entry.path),
  pathParams: entry.params.filter((param) => param.in === 'path'),
}));

export function routeForDomainOperation(request, url, body) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';
  for (const { entry, pattern, pathParams } of COMPILED) {
    if (entry.method !== method) continue;
    const match = pattern.exec(path);
    if (!match) continue;

    const payload = {};
    pathParams.forEach((param, index) => { payload[param.arg] = parseValue(param, match[index + 1], false); });

    const queryParams = entry.params.filter((param) => param.in === 'query');
    for (const key of url.searchParams.keys()) {
      if (FORBIDDEN.includes(key)) fail('forbidden_field', key);
      if (!queryParams.some((param) => param.name === key)) fail('unexpected_field', key);
    }
    for (const param of queryParams) {
      const raw = url.searchParams.get(param.name);
      if (raw == null || raw === '') {
        if (param.required) fail('required_field', param.name);
        continue;
      }
      payload[param.arg] = parseValue(param, raw, true);
    }

    const bodyParams = entry.params.filter((param) => param.in === 'body');
    if (method !== 'GET') {
      const value = body ?? {};
      if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid_json_object');
      for (const key of Object.keys(value)) {
        if (FORBIDDEN.includes(key)) fail('forbidden_field', key);
        if (!bodyParams.some((param) => param.name === key)) fail('unexpected_field', key);
      }
      for (const param of bodyParams) {
        if (!Object.prototype.hasOwnProperty.call(value, param.name) || value[param.name] === null) {
          if (param.required) fail('required_field', param.name);
          continue;
        }
        payload[param.arg] = parseValue(param, value[param.name], false);
      }
    }

    return { rpc: entry.rpc, payload, responseKind: 'json', operationId: entry.id };
  }
  return null;
}

export const __testing = Object.freeze({ parseValue, pathPattern });
