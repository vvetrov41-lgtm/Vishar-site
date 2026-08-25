// Role capabilities, mirrored from the database.
//
// READ THIS BEFORE RELYING ON IT.
//
// Nothing here is a security control. Every capability below is enforced by
// row level security, table and column privileges, and the role checks inside
// the workflow RPCs. This module exists so the interface does not offer a
// control that would only fail, and so a deactivated account is shown the door
// instead of a wall of empty screens.
//
// A user who edits these values in their browser gains nothing: the database
// refuses the operation regardless. Conversely, adding a capability here does
// not grant it - the corresponding migration has to grant it too.

import type { ArtistMembership, CrmRole, EnquiryStatus, StatusTransition } from './types';

export type Capability =
  | 'viewClients'
  | 'editClient'
  | 'viewEnquiries'
  | 'editEnquiry'
  | 'manageEnquiryFiles'
  | 'removeEnquiryFiles'
  | 'createEnquiry'
  | 'transitionEnquiry'
  | 'assignEnquiry'
  | 'convertEnquiry'
  | 'viewEnquiryFiles'
  | 'viewProjects'
  | 'manageProjects'
  | 'viewSessions'
  | 'manageSessions'
  | 'viewAutomations'
  | 'viewFinance'
  | 'manageFinance'
  | 'viewNotes'
  | 'createNotes'
  | 'viewFollowUps'
  | 'manageFollowUps'
  | 'createEmailDraft'
  | 'approveEmail'
  | 'viewActivity'
  | 'viewIntegrationJobs'
  | 'manageIntegrations'
  | 'viewNotifications'
  | 'manageUsers'
  | 'manageSettings';

const OWNER: Capability[] = [
  'viewClients', 'editClient',
  'viewEnquiries', 'createEnquiry', 'transitionEnquiry', 'assignEnquiry', 'convertEnquiry', 'viewEnquiryFiles',
  'editEnquiry', 'manageEnquiryFiles', 'removeEnquiryFiles',
  'viewProjects', 'manageProjects',
  'viewSessions', 'manageSessions', 'viewAutomations', 'viewFinance', 'manageFinance',
  'viewNotes', 'createNotes', 'viewFollowUps', 'manageFollowUps',
  'createEmailDraft', 'approveEmail', 'viewActivity', 'viewIntegrationJobs', 'manageIntegrations',
  'viewNotifications',
  'manageUsers', 'manageSettings',
];

const BOOKING_MANAGER: Capability[] = [
  'viewClients', 'editClient',
  'viewEnquiries', 'createEnquiry', 'transitionEnquiry', 'assignEnquiry', 'convertEnquiry', 'viewEnquiryFiles',
  'editEnquiry', 'manageEnquiryFiles',
  'viewProjects', 'manageProjects',
  'viewSessions', 'manageSessions', 'viewAutomations',
  'viewNotes', 'createNotes', 'viewFollowUps', 'manageFollowUps',
  'createEmailDraft',
  'viewActivity', 'manageIntegrations', 'viewNotifications',
  // The frontend can only express the coarse global role. The database narrows
  // finance and Calendar Connections to memberships whose capability flags are
  // true. Deliberately absent: viewFinance, manageFinance, approveEmail,
  // viewIntegrationJobs, manageUsers, manageSettings.
];

const READ_ONLY: Capability[] = [
  'viewClients',
  'viewEnquiries',
  'viewProjects',
  'viewSessions',
  'viewAutomations',
  'viewFollowUps',
  'viewNotifications',
  // Deliberately absent: every write, all finance, files, notes, emails,
  // activity, integration jobs, integration management, users and settings.
];

const CAPABILITIES: Record<CrmRole, ReadonlySet<Capability>> = {
  owner: new Set(OWNER),
  booking_manager: new Set(BOOKING_MANAGER),
  read_only: new Set(READ_ONLY),
};

type ScopedMembership = Pick<
  ArtistMembership,
  'is_active' | 'can_view_finance' | 'can_manage_finance' | 'can_manage_integrations'
>;

/**
 * `role` is null when there is no active profile - a signed-in account that was
 * never provisioned, or one that has been deactivated. Both get nothing.
 */
export function can(role: CrmRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return CAPABILITIES[role].has(capability);
}

/**
 * UI affordances that depend on per-artist membership flags must use this
 * helper. The database/RLS/RPC layer remains authoritative: a forged browser
 * flag still cannot widen access.
 */
export function canAccess(
  role: CrmRole | null | undefined,
  capability: Capability,
  memberships: ScopedMembership[] = []
): boolean {
  if (!role) return false;
  if (role === 'owner') return can(role, capability);

  if (capability === 'viewFinance') {
    return role !== 'read_only' && memberships.some(
      (membership) => membership.is_active && (membership.can_view_finance || membership.can_manage_finance)
    );
  }

  if (capability === 'manageFinance') {
    return role !== 'read_only' && memberships.some(
      (membership) => membership.is_active && membership.can_manage_finance
    );
  }

  if (capability === 'manageIntegrations') {
    return can(role, capability) && memberships.some(
      (membership) => membership.is_active && membership.can_manage_integrations
    );
  }

  return can(role, capability);
}

export function capabilitiesFor(role: CrmRole | null | undefined): Capability[] {
  if (!role) return [];
  return [...CAPABILITIES[role]];
}

export const ROLE_LABELS: Record<CrmRole, string> = {
  owner: 'Owner',
  booking_manager: 'Booking manager',
  read_only: 'Read only',
};

export const ENQUIRY_STATUS_LABELS: Record<EnquiryStatus, string> = {
  new: 'New',
  reviewing: 'Reviewing',
  waiting_for_client: 'Waiting for client',
  accepted: 'Accepted',
  declined: 'Declined',
  quote_sent: 'Quote sent',
  deposit_requested: 'Deposit requested',
  deposit_paid: 'Deposit paid',
  converted: 'Converted',
  closed: 'Closed',
};

/**
 * The transitions this user may actually perform, from the allow-list the
 * database holds. Offering an owner-only transition to a manager would produce
 * a guaranteed error, so it is not offered.
 */
export function availableTransitions(
  transitions: StatusTransition[],
  from: EnquiryStatus,
  role: CrmRole | null | undefined
): StatusTransition[] {
  if (!can(role, 'transitionEnquiry')) return [];
  return transitions.filter(
    (transition) =>
      transition.from_status === from && (!transition.owner_only || role === 'owner')
  );
}

export interface NavItem {
  path: string;
  label: string;
  capability: Capability;
}

// Deliberately absent: the control plane at /workspaces. Workspace authority
// lives in workspace_memberships and has no relationship to CrmRole, so it
// cannot be expressed here without the browser inventing an answer. AppShell
// appends that entry from public.control_plane_access() instead.
export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Dashboard', capability: 'viewEnquiries' },
  { path: '/inbox', label: 'Communications', capability: 'viewEnquiries' },
  { path: '/enquiries', label: 'Enquiries', capability: 'viewEnquiries' },
  { path: '/clients', label: 'Clients', capability: 'viewClients' },
  { path: '/projects', label: 'Projects', capability: 'viewProjects' },
  { path: '/appointments', label: 'Appointments', capability: 'viewSessions' },
  { path: '/availability', label: 'Time off', capability: 'viewSessions' },
  { path: '/automations', label: 'Automations', capability: 'viewAutomations' },
  { path: '/payments', label: 'Payments', capability: 'manageFinance' },
  // One entry. Calendar, WhatsApp and Instagram were three peers here, which
  // stopped scaling at three; the hub at /integrations lists every channel and
  // links on to the per-provider screens.
  { path: '/integrations', label: 'nav.integrations', capability: 'manageIntegrations' },
  { path: '/notifications', label: 'nav.notifications', capability: 'viewNotifications' },
  { path: '/users', label: 'Users', capability: 'manageUsers' },
  { path: '/activity', label: 'Activity', capability: 'viewActivity' },
];

export function navItemsFor(
  role: CrmRole | null | undefined,
  memberships: ScopedMembership[] = []
): NavItem[] {
  return NAV_ITEMS.filter((item) => canAccess(role, item.capability, memberships));
}
