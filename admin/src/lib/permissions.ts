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
// not grant it — the corresponding migration has to grant it too.

import type { CrmRole, EnquiryStatus, StatusTransition } from './types';

export type Capability =
  | 'viewClients'
  | 'editClientContact'
  | 'viewEnquiries'
  | 'transitionEnquiry'
  | 'assignEnquiry'
  | 'convertEnquiry'
  | 'viewEnquiryFiles'
  | 'viewProjects'
  | 'manageProjects'
  | 'viewSessions'
  | 'manageSessions'
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
  | 'manageUsers'
  | 'manageSettings';

const OWNER: Capability[] = [
  'viewClients', 'editClientContact',
  'viewEnquiries', 'transitionEnquiry', 'assignEnquiry', 'convertEnquiry', 'viewEnquiryFiles',
  'viewProjects', 'manageProjects',
  'viewSessions', 'manageSessions',
  'viewFinance', 'manageFinance',
  'viewNotes', 'createNotes',
  'viewFollowUps', 'manageFollowUps',
  'createEmailDraft', 'approveEmail',
  'viewActivity', 'viewIntegrationJobs',
  'manageUsers', 'manageSettings',
];

const BOOKING_MANAGER: Capability[] = [
  'viewClients', 'editClientContact',
  'viewEnquiries', 'transitionEnquiry', 'assignEnquiry', 'convertEnquiry', 'viewEnquiryFiles',
  'viewProjects', 'manageProjects',
  'viewSessions', 'manageSessions',
  'viewNotes', 'createNotes',
  'viewFollowUps', 'manageFollowUps',
  'createEmailDraft',
  'viewActivity',
  // Deliberately absent: viewFinance, manageFinance, approveEmail,
  // viewIntegrationJobs, manageUsers, manageSettings.
];

const READ_ONLY: Capability[] = [
  'viewClients',
  'viewEnquiries',
  'viewProjects',
  'viewSessions',
  'viewFollowUps',
  // Deliberately absent: every write, all finance, files, notes, emails,
  // activity, integration jobs, users and settings.
];

const CAPABILITIES: Record<CrmRole, ReadonlySet<Capability>> = {
  owner: new Set(OWNER),
  booking_manager: new Set(BOOKING_MANAGER),
  read_only: new Set(READ_ONLY),
};

/**
 * `role` is null when there is no active profile — a signed-in account that was
 * never provisioned, or one that has been deactivated. Both get nothing.
 */
export function can(role: CrmRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return CAPABILITIES[role].has(capability);
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

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Dashboard', capability: 'viewEnquiries' },
  { path: '/enquiries', label: 'Enquiries', capability: 'viewEnquiries' },
  { path: '/clients', label: 'Clients', capability: 'viewClients' },
  { path: '/projects', label: 'Projects', capability: 'viewProjects' },
  { path: '/sessions', label: 'Sessions', capability: 'viewSessions' },
  { path: '/users', label: 'Users', capability: 'manageUsers' },
  { path: '/activity', label: 'Activity', capability: 'viewActivity' },
];

export function navItemsFor(role: CrmRole | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => can(role, item.capability));
}
