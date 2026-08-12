// Role capabilities, mirrored from the database.
//
// Nothing here is a security control. Database RLS, privileges and RPC checks
// remain authoritative.

import type { CrmRole, EnquiryStatus, StatusTransition } from './types';

export type Capability =
  | 'viewClients' | 'viewEnquiries' | 'createEnquiry' | 'transitionEnquiry'
  | 'assignEnquiry' | 'convertEnquiry' | 'viewEnquiryFiles'
  | 'viewProjects' | 'manageProjects' | 'viewSessions' | 'manageSessions'
  | 'viewFinance' | 'manageFinance' | 'viewNotes' | 'createNotes'
  | 'viewFollowUps' | 'manageFollowUps' | 'createEmailDraft' | 'approveEmail'
  | 'viewActivity' | 'viewIntegrationJobs' | 'manageIntegrations'
  | 'manageUsers' | 'manageSettings';

const OWNER: Capability[] = [
  'viewClients', 'viewEnquiries', 'createEnquiry', 'transitionEnquiry', 'assignEnquiry', 'convertEnquiry', 'viewEnquiryFiles',
  'viewProjects', 'manageProjects', 'viewSessions', 'manageSessions', 'viewFinance', 'manageFinance',
  'viewNotes', 'createNotes', 'viewFollowUps', 'manageFollowUps', 'createEmailDraft', 'approveEmail',
  'viewActivity', 'viewIntegrationJobs', 'manageIntegrations', 'manageUsers', 'manageSettings',
];

const BOOKING_MANAGER: Capability[] = [
  'viewClients', 'viewEnquiries', 'createEnquiry', 'transitionEnquiry', 'assignEnquiry', 'convertEnquiry', 'viewEnquiryFiles',
  'viewProjects', 'manageProjects', 'viewSessions', 'manageSessions', 'viewNotes', 'createNotes',
  'viewFollowUps', 'manageFollowUps', 'createEmailDraft', 'viewActivity', 'manageIntegrations',
];

const READ_ONLY: Capability[] = [
  'viewClients', 'viewEnquiries', 'viewProjects', 'viewSessions', 'viewFollowUps',
];

const CAPABILITIES: Record<CrmRole, ReadonlySet<Capability>> = {
  owner: new Set(OWNER),
  booking_manager: new Set(BOOKING_MANAGER),
  read_only: new Set(READ_ONLY),
};

export function can(role: CrmRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return CAPABILITIES[role].has(capability);
}

export function capabilitiesFor(role: CrmRole | null | undefined): Capability[] {
  if (!role) return [];
  return [...CAPABILITIES[role]];
}

export const ROLE_LABELS: Record<CrmRole, string> = {
  owner: 'Owner', booking_manager: 'Booking manager', read_only: 'Read only',
};

export const ENQUIRY_STATUS_LABELS: Record<EnquiryStatus, string> = {
  new: 'New', reviewing: 'Reviewing', waiting_for_client: 'Waiting for client', accepted: 'Accepted',
  declined: 'Declined', quote_sent: 'Quote sent', deposit_requested: 'Deposit requested',
  deposit_paid: 'Deposit paid', converted: 'Converted', closed: 'Closed',
};

export function availableTransitions(
  transitions: StatusTransition[], from: EnquiryStatus, role: CrmRole | null | undefined
): StatusTransition[] {
  if (!can(role, 'transitionEnquiry')) return [];
  return transitions.filter((transition) => transition.from_status === from && (!transition.owner_only || role === 'owner'));
}

export interface NavItem { path: string; label: string; capability: Capability; }

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Dashboard', capability: 'viewEnquiries' },
  { path: '/enquiries', label: 'Enquiries', capability: 'viewEnquiries' },
  { path: '/clients', label: 'Clients', capability: 'viewClients' },
  { path: '/projects', label: 'Projects', capability: 'viewProjects' },
  { path: '/appointments', label: 'Appointments', capability: 'viewSessions' },
  { path: '/availability', label: 'Time off', capability: 'viewSessions' },
  { path: '/payments', label: 'Payments', capability: 'manageFinance' },
  { path: '/integrations', label: 'common.calendar', capability: 'manageIntegrations' },
  { path: '/users', label: 'Users', capability: 'manageUsers' },
  { path: '/activity', label: 'Activity', capability: 'viewActivity' },
];

export function navItemsFor(role: CrmRole | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => can(role, item.capability));
}
