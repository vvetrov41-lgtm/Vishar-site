import { availableTransitions } from './permissions';
import type { CrmRole, Enquiry, EnquiryStatus, StatusTransition } from './types';

export type EnquiryBoardColumnKey = 'new' | 'waiting' | 'ready' | 'deposit' | 'booked';

export interface EnquiryBoardColumn {
  key: EnquiryBoardColumnKey;
  statuses: readonly EnquiryStatus[];
}

export const ENQUIRY_BOARD_COLUMNS: readonly EnquiryBoardColumn[] = [
  { key: 'new', statuses: ['new', 'reviewing'] },
  { key: 'waiting', statuses: ['waiting_for_client'] },
  { key: 'ready', statuses: ['accepted', 'quote_sent'] },
  { key: 'deposit', statuses: ['deposit_requested', 'deposit_paid'] },
  { key: 'booked', statuses: ['converted'] },
] as const;

const STATUS_TO_COLUMN: Partial<Record<EnquiryStatus, EnquiryBoardColumnKey>> = {
  new: 'new',
  reviewing: 'new',
  waiting_for_client: 'waiting',
  accepted: 'ready',
  quote_sent: 'ready',
  deposit_requested: 'deposit',
  deposit_paid: 'deposit',
  converted: 'booked',
};

export function boardColumnForStatus(status: EnquiryStatus): EnquiryBoardColumnKey | null {
  return STATUS_TO_COLUMN[status] ?? null;
}

export type EnquiryBoardGroups = Record<EnquiryBoardColumnKey, Enquiry[]>;

export function groupEnquiriesForBoard(enquiries: Enquiry[]): EnquiryBoardGroups {
  const groups: EnquiryBoardGroups = {
    new: [],
    waiting: [],
    ready: [],
    deposit: [],
    booked: [],
  };

  for (const enquiry of enquiries) {
    const column = boardColumnForStatus(enquiry.status);
    if (column) groups[column].push(enquiry);
  }

  return groups;
}

/**
 * Quick moves are only a presentation over the existing workflow authority.
 *
 * - availableTransitions removes transitions the current role cannot perform.
 * - deposit_paid is deliberately excluded: that is a ledger state and must
 *   continue to come from the payment/deposit workflow.
 * - declined/closed stay on the detail/list workflow rather than the primary
 *   active board, so a casual quick move cannot make work disappear.
 */
export function boardMoveTargets(
  transitions: StatusTransition[],
  from: EnquiryStatus,
  role: CrmRole | null | undefined,
): EnquiryStatus[] {
  return availableTransitions(transitions, from, role)
    .map((transition) => transition.to_status)
    .filter((status) => status !== 'deposit_paid' && boardColumnForStatus(status) !== null);
}
