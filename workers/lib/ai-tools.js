// AI tool gateway definitions.
//
// NO GATEWAY IS RUNNING. This module defines the complete set of tools an AI
// assistant may ever be offered, and the constraints each one carries. There is
// no execution backend, no credential, and no route wired to it.
//
// The design rule is that an AI assistant gets the same narrow surface a member
// of staff gets, and never more:
//
//   * ten named tools, and nothing else — no arbitrary SQL, no generic table
//     endpoint, no "run this query" escape hatch;
//   * every tool declares the role it needs, and the caller's own role is what
//     is checked — the gateway does not act on its own authority;
//   * every read declares exactly which fields it may return, so a tool cannot
//     quietly widen into a client-data export;
//   * every read is paginated with a hard row cap;
//   * every write would go through a named SECURITY DEFINER RPC. The future
//     gateway must add attributable AI/on-behalf-of audit semantics before any
//     execution route is connected;
//   * `create_email_draft` can only draft. There is no send tool.

/** Hard limits. A tool may ask for fewer rows, never more. */
export const MAX_ROWS_PER_CALL = 25;
export const DEFAULT_ROWS_PER_CALL = 10;

/**
 * The complete tool set. Adding an entry here is a deliberate act: it widens
 * what an AI assistant can see or do, and needs the same scrutiny as widening
 * a role.
 */
export const AI_TOOLS = Object.freeze([
  {
    name: 'search_clients',
    kind: 'read',
    summary: 'Find clients by name or contact detail.',
    requiresRole: ['owner', 'booking_manager'],
    rpc: null,
    // No email, no phone, no Instagram: an assistant helping triage does not
    // need contact details, and returning them would make every conversation a
    // potential contact-list export.
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
    // The RPC hard-codes `status = 'draft'` and a trigger refuses an
    // AI-originated row in any other state, so this cannot become a send tool
    // by changing an argument.
    draftOnly: true,
  },
]);

const TOOLS_BY_NAME = new Map(AI_TOOLS.map((tool) => [tool.name, tool]));

/** Names only — useful for building a tool manifest without leaking detail. */
export const AI_TOOL_NAMES = Object.freeze(AI_TOOLS.map((tool) => tool.name));

export function getTool(name) {
  return TOOLS_BY_NAME.get(name) ?? null;
}

/**
 * Whether a caller in `role` may invoke `name`.
 *
 * The role is the *caller's*, resolved from their own identity. A gateway
 * credential is never the authority: it may execute a narrow RPC only after
 * this check has passed, and it is never disclosed to the assistant.
 */
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

/**
 * Drops every field a tool did not declare. A read tool returns its declared
 * projection or nothing — it cannot leak a column by accident because the query
 * happened to select it.
 */
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

/** No executable gateway, credential, or route is present in this repository. */
export const AI_GATEWAY_CONNECTED = false;
