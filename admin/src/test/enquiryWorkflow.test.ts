import { describe, expect, it } from 'vitest';
import { enquiryWorkflowActions } from '../lib/enquiryWorkflow';
import type { StatusTransition } from '../lib/types';

const depositRequestedTransitions: StatusTransition[] = [
  {
    from_status: 'deposit_requested',
    to_status: 'deposit_paid',
    owner_only: false,
    note: 'Requires a settled project deposit ledger request',
  },
  {
    from_status: 'deposit_requested',
    to_status: 'converted',
    owner_only: false,
    note: 'Create the project before recording payment',
  },
  {
    from_status: 'deposit_requested',
    to_status: 'closed',
    owner_only: false,
    note: null,
  },
];

describe('enquiryWorkflowActions', () => {
  it('keeps a deposit-requested enquiry convertible while hiding the impossible paid transition', () => {
    const result = enquiryWorkflowActions(
      depositRequestedTransitions,
      'deposit_requested',
      'booking_manager'
    );

    expect(result.canConvert).toBe(true);
    expect(result.transitionOptions.map((transition) => transition.to_status)).toEqual([
      'converted',
      'closed',
    ]);
  });

  it('does not grant conversion to read-only users', () => {
    const result = enquiryWorkflowActions(
      depositRequestedTransitions,
      'deposit_requested',
      'read_only'
    );

    expect(result.canConvert).toBe(false);
    expect(result.transitionOptions).toEqual([]);
  });

  it('preserves the normal accepted conversion path', () => {
    const result = enquiryWorkflowActions([], 'accepted', 'booking_manager');
    expect(result.canConvert).toBe(true);
  });
});
