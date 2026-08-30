import type { CrmRole, EnquiryStatus, StatusTransition } from './types';
import { availableTransitions, can } from './permissions';

/**
 * Build the enquiry actions the UI can safely offer before a project exists.
 *
 * `deposit_paid` is a project-ledger state: the database requires an existing
 * project and a settled deposit request before that transition can succeed.
 * A deposit-requested enquiry must therefore be convertible first rather than
 * being led into a guaranteed permission-looking refusal.
 */
export function enquiryWorkflowActions(
  transitions: StatusTransition[],
  status: EnquiryStatus,
  role: CrmRole | null | undefined
) {
  const transitionOptions = availableTransitions(transitions, status, role).filter(
    (transition) => !(status === 'deposit_requested' && transition.to_status === 'deposit_paid')
  );

  const canConvert = can(role, 'convertEnquiry')
    && ['accepted', 'deposit_requested', 'deposit_paid'].includes(status);

  return { transitionOptions, canConvert };
}
