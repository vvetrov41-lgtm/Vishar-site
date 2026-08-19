// AI tool gateway definitions.
//
// NO GATEWAY IS DEPLOYED. This module defines the complete allow-list of tools
// an AI assistant may ever be offered. The appointment proxy and RPC code exist
// only as an inactive foundation until exact-head CI, retained-staging OAuth
// configuration and hosted E2E are complete.
//
// The design rule is that an AI assistant gets the same narrow surface as the
// authenticated human and never more:
//
//   * named tools only, with no arbitrary SQL or generic table endpoint;
//   * the caller's Supabase OAuth identity remains authoritative;
//   * GPT artist scope is resolved server-side from OAuth user membership and
//     active context, with legacy fixed-client compatibility during migration;
//   * every read declares exactly which fields it may return;
//   * every read is paginated with a hard row cap;
//   * appointment writes are idempotent, version-checked and AI-audited;
//   * `create_email_draft` can only draft. There is no send tool.

/** Hard limits. A tool may ask for fewer rows, never more. */
export const MAX_ROWS_PER_CALL = 25;
export const DEFAULT_ROWS_PER_CALL = 10;

/**
 * The complete tool set. Adding an entry here is a deliberate permission
 * expansion and requires the same scrutiny as widening a CRM role.
 */
export const AI_TOOLS = Object.freeze([
  {
    name: 'search_clients',
    kind: 'read',
    summary: 'Find clients by name or contact detail.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: null,
    returns: ['id', 'full_name', 'travelling_from', 'created_at'],
    paginated: true,
  },
  {
    name: 'get_client',
    kind: 'read',
    summary: 'Read one client record.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: null,
    returns: ['id', 'full_name', 'preferred_contact', 'travelling_from', 'notes_summary', 'created_at'],
    paginated: false,
  },
  {
    name: 'search_enquiries',
    kind: 'read',
    summary: 'Find enquiries by reference, status or assignment.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: null,
    returns: ['id', 'reference_number', 'status', 'project_type', 'placement', 'created_at', 'last_action_at'],
    paginated: true,
  },
  {
    name: 'get_enquiry',
    kind: 'read',
    summary: 'Read one enquiry, including the described idea.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: null,
    returns: [
      'id', 'reference_number', 'status', 'project_type', 'placement',
      'approximate_size', 'cover_up', 'preferred_timing', 'idea', 'created_at',
    ],
    paginated: false,
  },
  {
    name: 'list_follow_ups',
    kind: 'read',
    summary: 'List open follow-ups, optionally only overdue ones.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: null,
    returns: ['id', 'subject', 'due_at', 'status', 'enquiry_id', 'client_id'],
    paginated: true,
  },
  {
    name: 'update_enquiry_status',
    kind: 'write',
    summary: 'Move an enquiry to an allowed next status.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: 'transition_enquiry_status',
    returns: ['enquiry_id', 'from_status', 'to_status'],
    paginated: false,
  },
  {
    name: 'assign_enquiry',
    kind: 'write',
    summary: 'Assign an enquiry to an active owner or booking manager.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: 'assign_enquiry',
    returns: ['enquiry_id', 'assigned_to'],
    paginated: false,
  },
  {
    name: 'create_internal_note',
    kind: 'write',
    summary: 'Add a staff-only note to a client, enquiry, project or session.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: 'create_internal_note',
    returns: ['note_id'],
    paginated: false,
  },
  {
    name: 'create_follow_up',
    kind: 'write',
    summary: 'Create a dated follow-up reminder.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: 'create_follow_up',
    returns: ['follow_up_id'],
    paginated: false,
  },
  {
    name: 'create_email_draft',
    kind: 'write',
    summary: 'Draft an email for a person to review. It cannot be sent.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: 'create_email_draft',
    returns: ['email_message_id', 'status'],
    paginated: false,
    draftOnly: true,
  },
  {
    name: 'search_appointment_clients',
    kind: 'read',
    summary: 'Find client IDs by name only inside the server-resolved artist context.',
    requiresRole: ['owner', 'booking_manager'],
    artistCapability: 'view',
    oauthClientBound: true,
    rpc: 'gpt_search_clients',
    returns: ['client_id', 'client_name'],
    paginated: true,
  },
  {
    name: 'list_appointments',
    kind: 'read',
    summary: 'List appointments in the server-resolved artist context.',
    requiresRole: ['owner', 'booking_manager'],
    artistCapability: 'view',
    oauthClientBound: true,
    rpc: 'gpt_list_appointments',
    returns: [
      'appointment_id', 'appointment_type', 'status', 'start_at', 'end_at',
      'calendar_version', 'calendar_sync_status', 'client_id', 'client_name',
      'enquiry_id', 'project_id',
    ],
    paginated: true,
  },
  {
    name: 'get_appointment',
    kind: 'read',
    summary: 'Read one appointment only inside the server-resolved artist context.',
    requiresRole: ['owner', 'booking_manager'],
    artistCapability: 'view',
    oauthClientBound: true,
    rpc: 'gpt_get_appointment',
    returns: [
      'appointment_id', 'appointment_type', 'status', 'start_at', 'end_at',
      'calendar_version', 'calendar_sync_status', 'client_id', 'client_name',
      'enquiry_id', 'project_id',
    ],
    paginated: false,
  },
  {
    name: 'check_appointment_conflicts',
    kind: 'read',
    summary: 'Check a proposed time range against appointments in the active artist context.',
    requiresRole: ['owner', 'booking_manager'],
    artistCapability: 'view',
    oauthClientBound: true,
    rpc: 'gpt_list_appointment_conflicts',
    returns: ['appointment_id', 'appointment_type', 'status', 'start_at', 'end_at', 'client_name'],
    paginated: true,
  },
  {
    name: 'schedule_appointment',
    kind: 'write',
    summary: 'Create an appointment in the active artist context with idempotency protection.',
    requiresRole: ['owner', 'booking_manager'],
    artistCapability: 'manage_sessions',
    oauthClientBound: true,
    rpc: 'gpt_schedule_appointment',
    returns: ['appointment_id', 'status', 'calendar_version', 'calendar_sync_status'],
    paginated: false,
    consequential: true,
  },
  {
    name: 'reschedule_appointment',
    kind: 'write',
    summary: 'Move an appointment in the active artist context after an optimistic version check.',
    requiresRole: ['owner', 'booking_manager'],
    artistCapability: 'manage_sessions',
    oauthClientBound: true,
    rpc: 'gpt_reschedule_appointment',
    returns: ['appointment_id', 'changed', 'start_at', 'end_at', 'calendar_version'],
    paginated: false,
    consequential: true,
  },
  {
    name: 'cancel_appointment',
    kind: 'write',
    summary: 'Cancel an appointment in the active artist context after an optimistic version check.',
    requiresRole: ['owner', 'booking_manager'],
    artistCapability: 'manage_sessions',
    oauthClientBound: true,
    rpc: 'gpt_cancel_appointment',
    returns: ['appointment_id', 'from_status', 'to_status', 'changed', 'calendar_version'],
    paginated: false,
    consequential: true,
  },
]);

const TOOLS_BY_NAME = new Map(AI_TOOLS.map((tool) => [tool.name, tool]));

/**
 * The original internal CRM assistant manifest remains stable. GPT appointment
 * Actions use the separate OAuth-bound list below and are never mixed into the
 * generic internal assistant surface.
 */
export const AI_TOOL_NAMES = Object.freeze(
  AI_TOOLS.filter((tool) => !tool.oauthClientBound).map((tool) => tool.name),
);

/** Exact public action names offered by the private artist-bound GPT schema. */
export const GPT_APPOINTMENT_TOOL_NAMES = Object.freeze(
  AI_TOOLS.filter((tool) => tool.oauthClientBound).map((tool) => tool.name),
);

export function getTool(name) {
  return TOOLS_BY_NAME.get(name) ?? null;
}

export function isToolAllowed(name, role) {
  const tool = getTool(name);
  if (!tool || !role) return false;
  return tool.requiresRole.includes(role);
}

/** Clamps a requested page size to the hard cap. */
export function clampLimit(requested) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ROWS_PER_CALL;
  return Math.min(Math.floor(value), MAX_ROWS_PER_CALL);
}

/** Drops every field a tool did not explicitly declare. */
export function projectFields(name, row) {
  const tool = getTool(name);
  if (!tool || !row) return null;

  const projected = {};
  for (const field of tool.returns) {
    if (field in row) projected[field] = row[field];
  }
  return projected;
}

export function projectRows(name, rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => projectFields(name, row));
}

/** Code exists, but no validated or enabled GPT gateway is deployed. */
export const AI_GATEWAY_CONNECTED = false;
