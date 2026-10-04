// Fresh operator-parity inventory for the profile-bound Vishar Unified GPT (v2).
//
// Evidence, re-read on 2026-09-28 rather than inherited from the 2026-09-04
// projection:
//   - every `.rpc('name')` issued by the private CRM (`admin/src`, tests
//     excluded) at the observed repository head;
//   - every Worker endpoint the CRM calls directly (Team API, Gmail operator
//     API, Instagram connector, Calendar connector, Monzo setup, WhatsApp
//     Pages functions);
//   - the production Supabase function catalogue at the observed migration.
//
// Scope is what an authorised human can do in the CRM today. A row exists for
// every such action and carries exactly one GPT status:
//   available      exposed by a bounded, named GPT operation;
//   implement_now  a safe server contract exists and the GPT wrapper is owed;
//   ui_only        the action itself needs a human inside an external OAuth,
//                  provider or device interface, or runs before a CRM profile
//                  exists. `note` names the concrete interaction.
// There is deliberately no "gap" or "planned" status: missing coverage for an
// action with a safe contract is `implement_now`, never deferred scope.
//
// `docs/gpt-actions/operator-parity.mjs` is the frozen 2026-08-31 snapshot and
// is kept only as history.

export const PARITY_METADATA = Object.freeze({
  schemaVersion: 3,
  observedAt: '2026-09-28',
  observedRepositoryHead: '1461824a34cf084a7a4bd11c491a6e614cea3768',
  observedProductionSupabaseMigration: '20260928150000_profile_language_localized_notifications',
  hardImportedSchemaOperationLimit: 30,
  targetImportedSchemaOperationLimit: 25,
  statuses: Object.freeze(['available', 'implement_now', 'ui_only']),
  consequences: Object.freeze(['read', 'write', 'provider_send', 'money', 'permission']),
  // One Unified GPT, one OAuth application, one server-side Artist context.
  // Each Action domain is one imported schema on its own host because the GPT
  // editor refuses two Action sets on the same domain.
  actionDomains: Object.freeze({
    'CRM Core': 'gpt-actions.vishartattoo.com',
    Projects: 'gpt-projects.vishartattoo.com',
    Scheduling: 'gpt-scheduling.vishartattoo.com',
    'Project Finance': 'gpt-finance.vishartattoo.com',
    'Billing & Reconciliation': 'gpt-billing.vishartattoo.com',
    Communications: 'gpt-communications.vishartattoo.com',
    Notifications: 'gpt-notifications.vishartattoo.com',
    Automations: 'gpt-automations.vishartattoo.com',
    Integrations: 'gpt-integrations.vishartattoo.com',
    Team: 'gpt-team.vishartattoo.com',
    Workspace: 'gpt-workspace.vishartattoo.com',
    Research: 'gpt-operations.vishartattoo.com',
    Cloudflare: 'gpt-cloudflare.vishartattoo.com',
  }),
  // CRM-callable RPCs that are not operator actions in their own right. Each
  // is listed with the reason so the drift test can prove nothing is silently
  // skipped.
  nonOperatorUiRpcs: Object.freeze({
    list_accessible_artists: 'Artist scope picker; the GPT equivalent is context.list.',
    list_assignable_profiles: 'Assignee picker feeding enquiries.assign; covered by enquiries.artist_staff.list.',
    get_gpt_action_consent_summary: 'Renders the GPT OAuth consent screen itself (gpt.oauth.consent).',
    get_gpt_consent_details: 'Renders the GPT OAuth consent screen itself (gpt.oauth.consent).',
    prepare_enquiry_reference_upload: 'Step of files.device_upload: signs a Storage upload for local bytes.',
    finalize_enquiry_reference_upload: 'Step of files.device_upload: seals bytes the browser just uploaded.',
    cancel_enquiry_reference_upload: 'Step of files.device_upload: abandons an unfinished browser upload.',
    bootstrap_artist_account: 'Step of signup.tenant.bootstrap, before any CRM profile exists.',
    request_enquiry_translation: 'Reading aid on the enquiry page: a cached machine translation of the client text. The assistant translates itself and needs no CRM operation.',
    get_enquiry_translation: 'Reading aid on the enquiry page: reads the cached translation back. The assistant translates itself and needs no CRM operation.',
  }),
  // Authenticated RPCs present in production that the CRM no longer calls.
  // They are not current operator actions, so parity neither exposes nor
  // counts them. Kept explicit so their reappearance in the UI fails the test.
  retiredFromCrmUi: Object.freeze([
    'list_automation_rules',
    'create_automation_rule',
    'resolve_message_template',
    'list_workspace_client_lifecycle_defaults',
    'upsert_workspace_client_lifecycle_default',
    'create_payment_request',
    'record_manual_refund',
    'create_artist_payment_policy',
    'transfer_work_to_artist',
    'set_tenant_invites',
    'update_retention_policy',
  ]),
  // RPCs a CRM Worker calls on the user's behalf as steps of one operator
  // action. They are covered by that action's row, not by their own.
  workerStepRpcs: Object.freeze({
    begin_staff_invite: 'team.invite (Team API Worker)',
    finalize_staff_invite: 'team.invite (Team API Worker)',
    begin_artist_invite: 'team.artist_invite (Team API Worker)',
    finalize_artist_invite: 'team.artist_invite (Team API Worker)',
  }),
  invariants: Object.freeze({
    missingCoverageIsImplementNow: true,
    arbitrarySqlOrRpcProxyAllowed: false,
    providerCredentialsModelSelectable: false,
    providerConsentRemainsHuman: true,
    artistIdOnlyOnContextRoute: true,
  }),
});

// owner_excluded: the owner decided the action stays a CRM screen action
// (irreversible, installation-wide or a UI gate), not a GPT operation.
const UI_ONLY_KINDS = new Set(['provider_handoff', 'device_local', 'pre_profile', 'owner_excluded']);

function row(key, actionDomain, capability, consequence, status, operationId, serverContracts, extra = {}) {
  return Object.freeze({
    key,
    actionDomain,
    capability,
    consequence,
    gpt: Object.freeze({ status, operationId: status === 'ui_only' ? null : operationId }),
    serverContracts: Object.freeze(serverContracts),
    mcp: status === 'ui_only' ? 'ui_only' : 'candidate',
    ui: extra.ui || 'available',
    note: extra.note || null,
  });
}

const A = 'available';
const N = 'implement_now';
const U = 'ui_only';

function uiOnly(key, actionDomain, capability, consequence, kind, note, serverContracts = []) {
  if (!UI_ONLY_KINDS.has(kind)) throw new Error(`unknown UI-only kind for ${key}`);
  return row(key, actionDomain, capability, consequence, U, null, serverContracts, { ui: kind, note });
}

export const OPERATOR_PARITY = Object.freeze([
  // ---------------------------------------------------------------- CRM Core
  row('context.list', 'CRM Core', 'view_crm', 'read', A, 'getArtistContext', ['public.gpt_artist_context', 'public.list_accessible_artists']),
  row('context.select', 'CRM Core', 'view_crm', 'write', A, 'selectArtistContext', ['public.gpt_artist_context']),
  row('context.capabilities', 'CRM Core', 'view_crm', 'read', A, 'listMyCapabilities', ['public.list_capabilities']),
  row('account.overview', 'Workspace', 'view_crm', 'read', A, 'getAccountOverview', ['public.account_overview']),
  row('account.display_name.set', 'Workspace', 'view_crm', 'write', A, 'setMyDisplayName', ['public.set_my_display_name']),
  row('account.language.set', 'Workspace', 'view_crm', 'write', A, 'setMyLanguage', ['public.set_my_ui_language']),
  uiOnly('account.delete', 'Workspace', 'view_crm', 'permission', 'owner_excluded',
    'Irreversible erasure of the signed-in account; the owner decided on 2026-09-30 that it stays a CRM screen action with typed confirmation, not a GPT operation.', ['public.delete_my_account']),
  row('today.pulse', 'CRM Core', 'view_crm', 'read', A, 'getTodayPulse', ['public.get_today_pulse']),
  row('statistics.summary', 'CRM Core', 'view_enquiries', 'read', A, 'getStatistics',
    ['public.gpt_get_statistics', 'RLS:public.statistics_enquiries', 'RLS:public.statistics_sessions', 'RLS:public.statistics_projects', 'RLS:public.statistics_payment_requests', 'RLS:public.statistics_payment_transactions'],
    { note: 'The CRM Statistics screen aggregates these views in the browser; the GPT gets the same figures aggregated server-side, money only with view_finance.' }),
  row('deliveries.failed.list', 'CRM Core', 'view_crm', 'read', A, 'listFailedDeliveries', ['public.gpt_list_failed_deliveries', 'RLS:public.integration_outbox']),
  row('clients.list', 'CRM Core', 'view_clients', 'read', A, 'listClients', ['public.gpt_list_clients']),
  row('clients.search_for_appointment', 'CRM Core', 'view_clients', 'read', A, 'searchAppointmentClients', ['public.gpt_search_clients']),
  row('clients.get', 'CRM Core', 'view_clients', 'read', A, 'getClient', ['public.gpt_get_client']),
  row('clients.update', 'CRM Core', 'manage_clients', 'write', A, 'updateClient', ['public.gpt_update_client', 'public.update_client_details']),
  row('clients.archive', 'CRM Core', 'manage_clients', 'write', A, 'archiveClient', ['public.update_client_details']),
  row('clients.ai_state.get', 'CRM Core', 'view_clients', 'read', A, 'getClientAiState', ['public.get_client_ai_state']),
  row('enquiries.list', 'CRM Core', 'view_enquiries', 'read', A, 'listEnquiries', ['public.gpt_list_enquiries']),
  row('enquiries.create_manual', 'CRM Core', 'manage_enquiries', 'write', A, 'createManualEnquiry', ['public.gpt_create_manual_enquiry', 'public.create_manual_enquiry']),
  row('enquiries.get', 'CRM Core', 'view_enquiries', 'read', A, 'getEnquiry', ['public.gpt_get_enquiry']),
  row('enquiries.update', 'CRM Core', 'manage_enquiries', 'write', A, 'updateEnquiry', ['public.gpt_update_enquiry', 'public.update_enquiry_details']),
  row('enquiries.archive', 'CRM Core', 'manage_enquiries', 'write', A, 'archiveEnquiry', ['public.update_enquiry_details']),
  row('enquiries.get_full', 'CRM Core', 'view_enquiries', 'read', A, 'getEnquiryFull', ['public.gpt_get_enquiry_full']),
  row('enquiries.set_status', 'CRM Core', 'manage_enquiries', 'write', A, 'setEnquiryStatus', ['public.gpt_set_enquiry_status', 'public.transition_enquiry_status']),
  row('enquiries.reply_outside_crm.set', 'Communications', 'manage_enquiries', 'write', N, 'setEnquiryReplyOutsideCrm',
    ['public.set_enquiry_reply_outside_crm', 'public.get_enquiry_reply_state'],
    { note: 'Shows why an enquiry counts as answered and lets the operator attest a reply the CRM could not see (answered, no reply time). GPT exposure owed (2026-10-04).' }),
  row('enquiries.artist_staff.list', 'CRM Core', 'assign_enquiries', 'read', A, 'listArtistStaff', ['public.gpt_list_artist_staff']),
  row('enquiries.assign', 'CRM Core', 'assign_enquiries', 'write', A, 'assignEnquiry', ['public.gpt_assign_enquiry', 'public.assign_enquiry']),
  row('enquiries.convert_to_project', 'CRM Core', 'manage_projects', 'write', A, 'convertEnquiryToProject', ['public.gpt_convert_enquiry_to_project', 'public.convert_enquiry_to_project']),
  row('enquiries.ai_result.get', 'CRM Core', 'view_enquiries', 'read', A, 'getEnquiryAiResult', ['public.get_enquiry_ai_result']),
  row('enquiries.ai.retry', 'CRM Core', 'manage_enquiries', 'write', A, 'retryEnquiryAi', ['public.retry_enquiry_ai']),

  // ---------------------------------------------------------------- Projects
  row('projects.list', 'Projects', 'view_projects', 'read', A, 'listProjects', ['public.gpt_list_projects']),
  row('projects.get', 'Projects', 'view_projects', 'read', A, 'getProject', ['public.gpt_get_project']),
  row('projects.update', 'Projects', 'manage_projects', 'write', A, 'updateProject', ['public.gpt_update_project_details']),
  row('projects.set_status', 'Projects', 'manage_projects', 'write', A, 'setProjectStatus', ['public.gpt_set_project_status', 'public.set_project_status']),
  row('notes.list', 'Projects', 'view_crm', 'read', A, 'listInternalNotes', ['public.gpt_list_internal_notes']),
  row('notes.create', 'Projects', 'manage_crm', 'write', A, 'createInternalNote', ['public.gpt_create_internal_note', 'public.create_internal_note']),
  row('files.enquiry.list', 'Projects', 'view_enquiries', 'read', A, 'listEnquiryFiles', ['public.gpt_list_enquiry_files']),
  row('files.project.list', 'Projects', 'view_projects', 'read', A, 'listProjectFiles', ['public.gpt_list_project_files']),
  row('files.enquiry.remove', 'Projects', 'manage_enquiries', 'write', A, 'removeEnquiryFile', ['public.remove_enquiry_reference_manifest']),
  row('activity.list', 'Projects', 'view_crm', 'read', A, 'listActivity', ['public.gpt_list_activity']),
  uiOnly('files.device_upload', 'Projects', 'manage_enquiries', 'write', 'device_local',
    'The file bytes live on the user device and are PUT straight to a signed Storage URL by the browser; a GPT Action cannot carry local binary files.',
    ['public.prepare_enquiry_reference_upload', 'public.finalize_enquiry_reference_upload', 'public.cancel_enquiry_reference_upload']),

  // -------------------------------------------------------------- Scheduling
  row('sessions.list', 'Scheduling', 'view_sessions', 'read', A, 'listAppointments', ['public.gpt_list_appointments']),
  row('sessions.schedule', 'Scheduling', 'manage_sessions', 'write', A, 'scheduleAppointment', ['public.gpt_schedule_appointment', 'public.schedule_appointment']),
  row('sessions.schedule_with_price', 'Scheduling', 'manage_sessions', 'write', A, 'scheduleAppointmentWithPrice', ['public.schedule_appointment_with_price']),
  row('sessions.price.set', 'Scheduling', 'manage_sessions', 'write', A, 'setAppointmentPrice', ['public.set_appointment_price']),
  row('sessions.check_conflicts', 'Scheduling', 'view_sessions', 'read', A, 'checkAppointmentConflicts', ['public.gpt_list_appointment_conflicts', 'public.list_appointment_conflicts']),
  row('sessions.booking_conflicts', 'Scheduling', 'view_sessions', 'read', A, 'checkBookingConflicts', ['public.list_booking_conflicts']),
  row('sessions.get', 'Scheduling', 'view_sessions', 'read', A, 'getAppointment', ['public.gpt_get_appointment']),
  row('sessions.get_full', 'Scheduling', 'view_sessions', 'read', A, 'getAppointmentFull', ['public.gpt_get_appointment_full']),
  row('sessions.reschedule', 'Scheduling', 'manage_sessions', 'write', A, 'rescheduleAppointment', ['public.gpt_reschedule_appointment', 'public.reschedule_appointment']),
  row('sessions.cancel', 'Scheduling', 'manage_sessions', 'write', A, 'cancelAppointment', ['public.gpt_cancel_appointment']),
  row('sessions.set_status', 'Scheduling', 'manage_sessions', 'write', A, 'setAppointmentStatus', ['public.gpt_set_appointment_status', 'public.set_appointment_status']),
  row('sessions.project.schedule', 'Scheduling', 'manage_sessions', 'write', A, 'scheduleProjectSession', ['public.schedule_session']),
  row('sessions.project.set_status', 'Scheduling', 'manage_sessions', 'write', A, 'setProjectSessionStatus', ['public.set_session_status']),
  row('sessions.booking_card.status', 'Scheduling', 'view_sessions', 'read', A, 'getSessionBookingCardStatus', ['public.get_session_booking_card_status']),
  row('sessions.consultation_context', 'Scheduling', 'view_sessions', 'read', A, 'getConsultationContext', ['public.gpt_get_consultation_context']),
  row('availability.list', 'Scheduling', 'view_sessions', 'read', A, 'listAvailability', ['public.gpt_list_availability_blocks', 'public.list_artist_availability_blocks']),
  row('availability.create', 'Scheduling', 'manage_sessions', 'write', A, 'createAvailability', ['public.gpt_create_availability_block', 'public.create_artist_availability_block']),
  row('availability.update', 'Scheduling', 'manage_sessions', 'write', A, 'updateAvailability', ['public.gpt_update_availability_block', 'public.update_artist_availability_block']),
  row('availability.cancel', 'Scheduling', 'manage_sessions', 'write', A, 'cancelAvailability', ['public.gpt_cancel_availability_block', 'public.cancel_artist_availability_block']),
  row('scheduling.preferences.get', 'Scheduling', 'view_sessions', 'read', A, 'getSchedulingPreferences', ['public.get_artist_scheduling_preferences']),
  row('scheduling.preferences.set', 'Scheduling', 'manage_sessions', 'write', A, 'setSchedulingPreferences', ['public.set_artist_scheduling_preferences']),
  row('scheduling.overrides.list', 'Scheduling', 'view_sessions', 'read', A, 'listScheduleOverrides', ['public.list_artist_schedule_overrides']),
  row('scheduling.override.set', 'Scheduling', 'manage_sessions', 'write', A, 'setScheduleOverride', ['public.set_artist_schedule_override']),
  row('scheduling.pricing.get', 'Scheduling', 'view_sessions', 'read', A, 'getSessionPricing', ['public.get_artist_session_pricing']),
  row('scheduling.pricing.set', 'Scheduling', 'manage_finance', 'money', A, 'setSessionPricing', ['public.set_artist_session_pricing']),

  // --------------------------------------------------------- Project Finance
  row('finance.project.get', 'Project Finance', 'view_finance', 'read', A, 'getProjectFinance', ['public.gpt_get_project_finance']),
  row('finance.project.update_estimate', 'Project Finance', 'manage_finance', 'write', A, 'updateProjectEstimate', ['public.gpt_update_project_estimate', 'public.update_project_estimate']),
  row('finance.project.update_deposit_legacy', 'Project Finance', 'manage_finance', 'money', A, 'updateProjectDeposit', ['public.gpt_update_project_deposit', 'public.update_project_deposit']),
  row('finance.project.deposit_policy.get', 'Project Finance', 'view_finance', 'read', A, 'getDepositPolicy', ['public.get_project_deposit_policy']),
  row('finance.project.deposit_policy.configure', 'Project Finance', 'manage_finance', 'money', A, 'configureDepositPolicy', ['public.configure_project_deposit_policy']),
  row('finance.project.deposit.preview', 'Project Finance', 'view_finance', 'read', A, 'previewProjectDeposit', ['public.preview_project_deposit']),
  row('finance.project.deposit.override.set', 'Project Finance', 'manage_finance', 'money', A, 'setProjectDepositOverride', ['public.set_project_deposit_override']),
  row('finance.project.deposit.request', 'Project Finance', 'manage_finance', 'money', A, 'requestProjectDeposit', ['public.request_project_deposit']),
  row('finance.project.deposit.confirm_manual', 'Project Finance', 'record_payments', 'money', A, 'confirmProjectDepositManually', ['public.confirm_project_deposit_manually']),
  row('payments.requests.list', 'Project Finance', 'view_finance', 'read', A, 'listPaymentRequests', ['public.gpt_list_payment_requests']),
  row('payments.session_deposit.request', 'Project Finance', 'manage_finance', 'money', A, 'requestSessionDeposit', ['public.gpt_request_session_deposit', 'public.request_session_deposit']),
  row('payments.session_deposit.request_grouped', 'Project Finance', 'manage_finance', 'money', A, 'requestGroupedSessionDeposit', ['public.request_grouped_session_deposit']),
  row('payments.request.cancel', 'Project Finance', 'manage_finance', 'money', A, 'cancelPaymentRequest', ['public.gpt_cancel_payment_request', 'public.cancel_payment_request']),
  row('payments.record_manual', 'Project Finance', 'record_payments', 'money', A, 'recordManualPayment', ['public.gpt_record_manual_payment', 'public.record_manual_payment']),

  // ------------------------------------------------ Billing & Reconciliation
  row('finance.invoices.list', 'Billing & Reconciliation', 'view_finance', 'read', A, 'listInvoices', ['public.list_invoices']),
  row('finance.invoices.get', 'Billing & Reconciliation', 'view_finance', 'read', A, 'getInvoice', ['public.get_invoice']),
  row('finance.invoices.create', 'Billing & Reconciliation', 'manage_finance', 'write', A, 'createInvoice', ['public.create_invoice']),
  row('finance.invoices.line_item.set', 'Billing & Reconciliation', 'manage_finance', 'write', A, 'setInvoiceLineItem', ['public.set_invoice_line_item']),
  row('finance.invoices.line_item.remove', 'Billing & Reconciliation', 'manage_finance', 'write', A, 'removeInvoiceLineItem', ['public.remove_invoice_line_item']),
  row('finance.invoices.details.set', 'Billing & Reconciliation', 'manage_finance', 'write', A, 'setInvoiceDetails', ['public.set_invoice_details']),
  row('finance.invoices.issue', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'issueInvoice', ['public.issue_invoice']),
  row('finance.invoices.void', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'voidInvoice', ['public.void_invoice']),
  row('finance.invoices.payment_request.attach', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'attachPaymentRequestToInvoice', ['public.attach_payment_request_to_invoice']),
  row('finance.invoices.payment.record', 'Billing & Reconciliation', 'record_payments', 'money', A, 'recordInvoicePayment', ['public.record_invoice_payment']),
  row('finance.invoices.credit_note.create', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'createCreditNote', ['public.create_credit_note']),
  row('payments.monzo.one_off_destination.attach', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'attachMonzoPaymentLink', ['public.attach_monzo_one_off_payment_destination']),
  row('monzo.destinations.list', 'Billing & Reconciliation', 'manage_finance', 'read', A, 'listMonzoDestinations', ['public.list_monzo_payment_destinations']),
  row('monzo.destinations.upsert', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'upsertMonzoDestination', ['public.upsert_monzo_payment_destination']),
  row('monzo.destinations.archive', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'archiveMonzoDestination', ['public.archive_monzo_payment_destination']),
  row('monzo.settings.get', 'Billing & Reconciliation', 'manage_finance', 'read', A, 'getMonzoTransferSettings', ['public.get_monzo_easy_bank_transfer_settings']),
  row('monzo.settings.configure', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'configureMonzoTransferSettings', ['public.configure_monzo_easy_bank_transfer']),
  row('monzo.reconciliation.list', 'Billing & Reconciliation', 'view_finance', 'read', A, 'listMonzoReconciliationCandidates', ['public.list_monzo_reconciliation_candidates']),
  row('monzo.reconciliation.match', 'Billing & Reconciliation', 'manage_finance', 'money', A, 'matchMonzoReconciliationCandidate', ['public.match_monzo_reconciliation_candidate']),
  row('monzo.reconciliation.ignore', 'Billing & Reconciliation', 'manage_finance', 'write', A, 'ignoreMonzoReconciliationCandidate', ['public.ignore_monzo_reconciliation_candidate']),
  row('monzo.reconciliation.confirm', 'Billing & Reconciliation', 'record_payments', 'money', A, 'confirmMonzoReconciliationCandidate', ['public.confirm_monzo_reconciliation_candidate']),

  // ---------------------------------------------------------- Communications
  row('whatsapp.conversation.get', 'Communications', 'view_communications', 'read', A, 'getWhatsAppConversation', ['public.gpt_get_whatsapp_conversation_for_enquiry']),
  row('whatsapp.conversation.ensure', 'Communications', 'manage_communications', 'write', A, 'ensureWhatsAppConversation', ['public.gpt_ensure_whatsapp_conversation', 'public.ensure_whatsapp_conversation_for_enquiry']),
  row('whatsapp.messages.list', 'Communications', 'view_communications', 'read', A, 'listWhatsAppMessages', ['public.gpt_list_whatsapp_messages']),
  row('whatsapp.message.send', 'Communications', 'manage_communications', 'provider_send', A, 'sendWhatsAppMessage', ['public.gpt_send_whatsapp_message', 'public.queue_whatsapp_message']),
  row('email.messages.list', 'Communications', 'view_communications', 'read', A, 'listEmailMessages', ['public.gpt_list_email_messages']),
  row('email.draft.create', 'Communications', 'manage_communications', 'write', A, 'createEmailDraft', ['public.gpt_create_email_draft']),
  row('email.draft.edit', 'Communications', 'manage_communications', 'write', A, 'editEmailDraft', ['public.edit_email_draft']),
  row('email.draft.approve_send', 'Communications', 'manage_communications', 'provider_send', A, 'approveEmailDraft', ['public.gpt_approve_email_draft', 'public.approve_email_draft']),
  row('email.failed.dismiss', 'Communications', 'manage_communications', 'write', A, 'dismissFailedEmail', ['public.dismiss_failed_email_message']),
  row('email.history.search', 'Communications', 'view_communications', 'read', A, 'searchEmailHistory', ['gpt-communications:/v1/enquiries/{enquiry_id}/gmail/history']),
  row('email.thread.get', 'Communications', 'view_communications', 'read', A, 'getEmailThread', ['gpt-communications:/v1/enquiries/{enquiry_id}/gmail/threads/{thread_context_id}']),
  row('email.reply_draft.create', 'Communications', 'manage_communications', 'write', A, 'createGmailReplyDraft', ['public.gpt_create_gmail_reply_draft']),
  row('email.client_history.search', 'Communications', 'manage_communications', 'read', A, 'searchClientEmailHistory', ['gmail-operator:/v1/operator/clients/{client_id}/gmail/history?artist_id']),
  row('email.inbox.list', 'Communications', 'manage_communications', 'read', A, 'listGmailInbox', ['gmail-operator:/v1/operator/artists/{artist_id}/gmail/inbox']),
  row('communications.conversations.list', 'Communications', 'view_communications', 'read', A, 'listCommunicationConversations', ['public.gpt_list_communication_conversations', 'public.list_communication_conversations']),
  row('communications.conversation.get', 'Communications', 'view_communications', 'read', A, 'getCommunicationConversation', ['public.gpt_get_communication_conversation']),
  row('communications.messages.list', 'Communications', 'view_communications', 'read', A, 'listCommunicationMessages', ['public.gpt_list_communication_messages']),
  row('communications.reply.send', 'Communications', 'manage_communications', 'provider_send', A, 'sendCommunicationReply', ['public.gpt_send_communication_reply', 'public.queue_communication_message']),
  row('communications.mark_read', 'Communications', 'manage_communications', 'write', A, 'markCommunicationConversationRead', ['public.gpt_mark_communication_conversation_read', 'public.mark_communication_conversation_read']),
  row('communications.state.set', 'Communications', 'manage_communications', 'write', A, 'setCommunicationConversationState', ['public.gpt_set_communication_conversation_state', 'public.set_communication_conversation_state']),
  row('communications.client.link', 'Communications', 'manage_communications', 'write', A, 'linkCommunicationConversationClient', ['public.gpt_link_communication_conversation_client', 'public.link_communication_conversation_client']),
  row('communications.client.link_suggestion', 'Communications', 'view_communications', 'read', A, 'getConversationLinkSuggestion', ['public.get_conversation_link_suggestion']),
  row('communications.client.create', 'Communications', 'manage_clients', 'write', A, 'createClientFromCommunication', ['public.gpt_create_client_from_communication', 'public.create_client_from_communication']),
  row('communications.enquiry.create', 'Communications', 'manage_enquiries', 'write', A, 'createEnquiryFromCommunication', ['public.gpt_create_enquiry_from_communication', 'public.create_enquiry_from_communication']),

  // ----------------------------------------------------------- Notifications
  row('followups.list', 'Notifications', 'view_notifications', 'read', A, 'listFollowUps', ['public.gpt_list_follow_ups']),
  row('followups.create', 'Notifications', 'manage_notifications', 'write', A, 'createFollowUp', ['public.gpt_create_follow_up', 'public.create_follow_up']),
  row('followups.complete', 'Notifications', 'manage_notifications', 'write', A, 'completeFollowUp', ['public.gpt_complete_follow_up', 'public.complete_follow_up']),
  row('followups.cancel', 'Notifications', 'manage_notifications', 'write', A, 'cancelFollowUp', ['public.gpt_cancel_follow_up']),
  row('followups.snooze', 'Notifications', 'manage_notifications', 'write', A, 'snoozeFollowUp', ['public.snooze_follow_up']),
  row('notifications.list', 'Notifications', 'view_notifications', 'read', A, 'listNotifications', ['public.list_notifications']),
  row('notifications.mark_read', 'Notifications', 'manage_notifications', 'write', A, 'markNotificationRead', ['public.mark_notification_read']),
  row('notifications.mark_all_read', 'Notifications', 'manage_notifications', 'write', A, 'markAllNotificationsRead', ['public.mark_all_notifications_read']),
  row('notifications.preferences.get', 'Notifications', 'view_notifications', 'read', A, 'getNotificationPreferences', ['RLS:public.notification_preferences']),
  row('notifications.preference.set', 'Notifications', 'manage_notifications', 'write', A, 'setNotificationPreference', ['public.set_notification_preference']),
  row('attention.acknowledgements.list', 'Notifications', 'view_notifications', 'read', A, 'listAttentionAcknowledgements', ['public.list_attention_acknowledgements']),
  row('attention.acknowledge', 'Notifications', 'manage_notifications', 'write', A, 'acknowledgeAttentionItem', ['public.acknowledge_attention_item']),
  row('attention.conversation_states.set', 'Notifications', 'manage_notifications', 'write', N, 'setConversationOperatorState',
    ['public.get_conversation_attention', 'public.set_conversation_not_crm', 'public.clear_attention_acknowledgement'],
    { note: 'Whether a conversation waits on the studio, plus the reversible operator states: personal / not CRM (unlinked only) and undoing "handled outside the CRM". GPT exposure owed (2026-10-04).' }),
  row('templates.list', 'Notifications', 'view_notifications', 'read', A, 'listMessageTemplates', ['public.list_client_lifecycle_templates']),
  row('templates.purposes.list', 'Notifications', 'view_notifications', 'read', A, 'listTemplatePurposes', ['public.list_client_lifecycle_template_purposes']),
  row('templates.variables.list', 'Notifications', 'view_notifications', 'read', A, 'listTemplateVariables', ['public.list_client_lifecycle_template_variables']),
  row('templates.upsert', 'Notifications', 'manage_automations', 'write', A, 'upsertMessageTemplate', ['public.upsert_message_template']),
  row('templates.set_active', 'Notifications', 'manage_automations', 'write', A, 'setMessageTemplateActive', ['public.set_message_template_active']),

  // ------------------------------------------------------------- Automations
  row('lifecycle.rules.list', 'Automations', 'view_automations', 'read', A, 'listLifecycleRules', ['public.list_client_lifecycle_rules']),
  row('lifecycle.rules.create', 'Automations', 'manage_automations', 'write', A, 'createLifecycleRule', ['public.create_client_lifecycle_rule']),
  row('lifecycle.rule.update_timing', 'Automations', 'manage_automations', 'write', A, 'updateLifecycleRuleTiming', ['public.update_client_lifecycle_rule_timing']),
  row('lifecycle.rule.set_enabled', 'Automations', 'manage_automations', 'write', A, 'setLifecycleRuleEnabled', ['public.set_automation_rule_enabled']),
  row('lifecycle.preview_sessions.list', 'Automations', 'view_automations', 'read', A, 'listLifecyclePreviewSessions', ['public.list_client_lifecycle_preview_sessions']),
  row('lifecycle.rule.preview', 'Automations', 'view_automations', 'read', A, 'previewLifecycleRule', ['public.preview_client_lifecycle_rule']),
  row('lifecycle.execution_history.list', 'Automations', 'view_automations', 'read', A, 'listLifecycleExecutionHistory', ['public.list_client_lifecycle_execution_history']),
  row('lifecycle.configuration_history.list', 'Automations', 'view_automations', 'read', A, 'listLifecycleConfigurationHistory', ['public.list_lifecycle_configuration_history']),
  row('lifecycle.health.get', 'Automations', 'view_automations', 'read', A, 'getLifecycleHealth', ['public.get_lifecycle_automation_health']),
  row('lifecycle.job.retry', 'Automations', 'manage_automations', 'write', A, 'retryLifecycleJob', ['public.retry_client_lifecycle_job']),
  row('automation.workspace_defaults.list', 'Automations', 'view_automations', 'read', A, 'listWorkspaceAutomationDefaults', ['public.list_workspace_automation_defaults']),
  row('automation.workspace_defaults.apply_to_artist', 'Automations', 'manage_automations', 'write', A, 'applyWorkspaceAutomationDefaults', ['public.apply_workspace_automation_defaults_to_artist']),

  // ------------------------------------------------------------ Integrations
  row('integrations.status.list', 'Integrations', 'view_integrations', 'read', A, 'listIntegrationStatus', ['public.list_integration_status']),
  row('calendar.connection.status', 'Integrations', 'view_integrations', 'read', A, 'listCalendarConnectionStatus', ['public.list_calendar_connection_status']),
  row('calendar.connection.reset_account', 'Integrations', 'manage_integrations', 'permission', A, 'resetCalendarExpectedAccount', ['public.reset_calendar_expected_account'],
    { note: 'Clearing the pinned Google account is a database action; the fresh Google consent that follows stays calendar.google_consent.' }),
  uiOnly('calendar.connection.disconnect', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'The Calendar connector authenticates this step with an interactive Cloudflare Access login and revokes the Google refresh token it alone holds; no bearer-token contract exists, and giving the GPT edge Google token custody would widen the trust boundary.',
    ['calendar-connector:/oauth/google/disconnect/{artist}']),
  row('instagram.connection.status', 'Integrations', 'manage_integrations', 'read', A, 'getInstagramConnectionStatus', ['instagram-connector:GET /v1/connections/status']),
  row('instagram.connection.start', 'Integrations', 'manage_integrations', 'permission', A, 'startInstagramConnection', ['instagram-connector:POST /v1/connections/start'],
    { note: 'Returns the Meta authorisation link; the consent itself is instagram.meta_consent.' }),
  row('instagram.disconnect', 'Integrations', 'manage_integrations', 'permission', A, 'disconnectInstagram', ['instagram-connector:POST /v1/connections/disconnect']),
  row('whatsapp.route.set_enabled', 'Integrations', 'manage_integrations', 'permission', A, 'setWhatsAppRouteEnabled', ['public.configure_artist_integration']),
  row('telegram.connector.info', 'Integrations', 'view_integrations', 'read', A, 'getTelegramConnectorInfo', ['public.get_telegram_connector_info']),
  row('telegram.connector.configure_username', 'Integrations', 'manage_integrations', 'permission', A, 'configureTelegramBotUsername', ['public.configure_telegram_connector_identity']),
  row('telegram.destinations.list', 'Integrations', 'view_integrations', 'read', A, 'listTelegramDestinations', ['public.list_telegram_destinations']),
  row('telegram.link.begin', 'Integrations', 'manage_integrations', 'permission', A, 'beginTelegramLink', ['public.begin_telegram_link'],
    { note: 'Returns the one-time Telegram deep link; pressing Start in Telegram is telegram.account_confirm.' }),
  row('telegram.destination.disconnect', 'Integrations', 'manage_integrations', 'permission', A, 'disconnectTelegramDestination', ['public.disconnect_telegram_destination']),
  row('booking_sources.list', 'Integrations', 'view_booking_sources', 'read', A, 'listBookingSources', ['public.list_booking_sources']),
  row('booking_sources.create', 'Integrations', 'manage_booking_sources', 'write', A, 'createBookingSource', ['public.create_booking_source']),
  row('booking_sources.update', 'Integrations', 'manage_booking_sources', 'write', A, 'updateBookingSource', ['public.update_booking_source']),
  uiOnly('calendar.google_consent', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'Google requires the account holder to sign in and grant Calendar scopes in Google\'s own consent screen.',
    ['calendar-connector:/oauth/google/start/{artist}']),
  uiOnly('instagram.meta_consent', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'Meta requires the Instagram account holder to log in and approve the app in Meta\'s own dialog.'),
  uiOnly('whatsapp.embedded_signup', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'WhatsApp Embedded Signup runs inside Meta\'s Facebook Login popup and returns a one-time code only to that browser session.',
    ['pages:/api/whatsapp/embedded-signup/provision']),
  uiOnly('whatsapp.existing_account.system_user_token', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'The system-user token is minted by the human in Meta Business Settings and pasted once into the CRM; the GPT must never receive provider secrets.',
    ['pages:/api/whatsapp/existing-account/provision']),
  uiOnly('whatsapp.meta_review.template', 'Integrations', 'manage_integrations', 'provider_send', 'provider_handoff',
    'Meta App Review demonstration flow that a reviewer drives from the CRM screen during Meta\'s review.',
    ['pages:/api/whatsapp/meta-review/template']),
  uiOnly('monzo.oauth_consent', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'Monzo requires the account holder to approve access in the Monzo app (strong customer authentication).',
    ['monzo-connector:/oauth/monzo/setup/{artist}']),
  uiOnly('telegram.account_confirm', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'The destination is bound only when the human presses Start in their own Telegram client.'),
  uiOnly('gpt.oauth.consent', 'Integrations', 'manage_integrations', 'permission', 'provider_handoff',
    'The GPT OAuth consent is the step that issues the GPT its token; it cannot be performed by the GPT.',
    ['public.get_gpt_consent_details', 'public.get_gpt_action_consent_summary']),

  // -------------------------------------------------------------------- Team
  row('team.profiles.list', 'Team', 'view_team', 'read', A, 'listTeamProfiles', ['public.list_profiles']),
  row('team.invite', 'Team', 'manage_team', 'permission', N, 'inviteStaffMember', ['team-admin:/v1/staff/invite']),
  row('team.artist_invite', 'Team', 'manage_team', 'permission', N, 'inviteArtist', ['team-admin:/v1/artist/invite']),
  row('team.profile.set_role', 'Team', 'manage_team', 'permission', A, 'setTeamProfileRole', ['public.set_profile_role']),
  row('team.profile.set_active', 'Team', 'manage_team', 'permission', A, 'setTeamProfileActive', ['public.set_profile_active']),
  row('team.memberships.list', 'Team', 'view_team', 'read', A, 'listTeamMemberships', ['public.list_team_memberships']),
  row('team.artist_membership.upsert', 'Team', 'manage_team', 'permission', A, 'upsertArtistMembership', ['public.upsert_artist_membership']),
  row('team.directory_profiles.list', 'Team', 'view_team', 'read', A, 'listDirectoryProfiles', ['public.list_directory_profiles']),
  row('team.workspace.list', 'Team', 'view_team', 'read', A, 'listWorkspaceTeam', ['public.list_workspace_team']),
  row('team.workspace_membership.upsert', 'Team', 'manage_team', 'permission', A, 'upsertWorkspaceMembership', ['public.upsert_workspace_membership']),
  row('team.artist_memberships.list', 'Team', 'view_team', 'read', A, 'listArtistMemberships', ['public.list_artist_memberships']),
  row('team.artist_membership.preview', 'Team', 'manage_team', 'read', A, 'previewArtistMembership', ['public.preview_membership_capabilities']),
  row('team.artist_membership.grant', 'Team', 'manage_team', 'permission', A, 'grantArtistMembership', ['public.grant_workspace_artist_membership']),
  row('team.artist_owner.seat', 'Team', 'manage_team', 'permission', A, 'seatArtistOwner', ['public.seat_artist_owner']),

  // --------------------------------------------------------------- Workspace
  uiOnly('workspace.control_plane_access', 'Workspace', 'view_crm', 'read', 'owner_excluded',
    'Tells the CRM which administration screens to show; a GPT operation needs no gate because each administration call is authorised on its own (owner decision 2026-09-30).', ['public.control_plane_access']),
  row('workspace.list', 'Workspace', 'view_crm', 'read', A, 'listWorkspaces', ['public.list_workspaces']),
  row('workspace.create', 'Workspace', 'manage_workspace', 'permission', A, 'createWorkspace', ['public.create_workspace']),
  row('workspace.update', 'Workspace', 'manage_workspace', 'permission', A, 'updateWorkspace', ['public.update_workspace']),
  uiOnly('workspace.ownership.transfer', 'Workspace', 'manage_workspace', 'permission', 'owner_excluded',
    'Irreversible hand-over of a studio, needed once in its life; the owner decided on 2026-09-30 that it stays a CRM screen action.', ['public.transfer_workspace_ownership']),
  row('workspace.artists.list', 'Workspace', 'view_crm', 'read', A, 'listWorkspaceArtists', ['public.list_workspace_artists']),
  row('artist.control_plane_context', 'Workspace', 'view_crm', 'read', A, 'getArtistControlPlaneContext', ['public.artist_control_plane_context']),
  row('artist.create', 'Workspace', 'manage_workspace', 'permission', A, 'createArtist', ['public.create_artist']),
  row('artist.update', 'Workspace', 'manage_workspace', 'permission', A, 'updateArtist', ['public.update_artist']),
  row('artist.onboarding_state', 'Workspace', 'view_crm', 'read', A, 'getArtistOnboardingState', ['public.artist_onboarding_state']),
  uiOnly('signup.policy.get', 'Workspace', 'view_crm', 'read', 'owner_excluded',
    'Installation-wide signup setting, not studio work; the owner decided on 2026-09-30 to keep it with its setter in the CRM.', ['public.self_service_signup_policy']),
  uiOnly('signup.availability.set', 'Workspace', 'manage_workspace', 'permission', 'owner_excluded',
    'Installation-wide switch for self-service artist signup, changed rarely; the owner decided on 2026-09-30 that it stays a CRM screen action.', ['public.set_self_service_signup']),
  row('team.invite_policy.get', 'Workspace', 'view_crm', 'read', A, 'getTenantInvitePolicy', ['public.tenant_invite_policy']),
  uiOnly('signup.tenant.bootstrap', 'Workspace', 'view_crm', 'permission', 'pre_profile',
    'Self-service signup runs before a CRM profile exists; the GPT OAuth boundary requires an active CRM profile, so no GPT token can exist yet.',
    ['public.bootstrap_artist_account']),

  // ---------------------------------------------------------------- Research
  row('research.deep_web_search', 'Research', 'view_research', 'read', A, 'searchWeb', ['public.gpt_authorize_web_research', 'gpt-operations:/v1/web/search']),
  row('research.read_web_page', 'Research', 'view_research', 'provider_send', A, 'scrapeWebPage', ['public.gpt_authorize_web_research', 'gpt-operations:/v1/web/scrape']),
]);

// Owner-only Cloudflare control. It is a GPT-side control-plane extension, not
// a CRM screen, so it is counted separately from CRM operator parity. The
// database refuses it unless the caller is the installation owner and the
// OAuth client row has `can_use_cloudflare_control`.
export const OWNER_EXTENSIONS = Object.freeze([
  'getCloudflareAccount', 'listCloudflareZones', 'listCloudflareWorkers', 'getCloudflareWorker',
  'listCloudflareWorkerDeployments', 'listCloudflarePagesProjects', 'listCloudflareD1Databases',
  'listCloudflareKvNamespaces', 'listCloudflareR2Buckets', 'listCloudflareDnsRecords',
  'listCloudflareWorkerRoutes', 'deployCloudflareWorkerCode', 'deleteCloudflareWorker',
  'upsertCloudflareDnsRecord', 'deleteCloudflareDnsRecord', 'purgeCloudflareCache',
  'upsertCloudflareWorkerRoute', 'deleteCloudflareWorkerRoute',
].map((operationId) => Object.freeze({ operationId, actionDomain: 'Cloudflare', gate: 'public.gpt_authorize_cloudflare_control' })));

export function paritySummary(rows = OPERATOR_PARITY) {
  const counts = { total: rows.length, available: 0, implement_now: 0, ui_only: 0 };
  for (const entry of rows) counts[entry.gpt.status] += 1;
  return counts;
}
