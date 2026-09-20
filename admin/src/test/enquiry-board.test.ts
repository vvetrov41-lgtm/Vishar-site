import { describe, expect, it } from 'vitest';
import {
  boardColumnForStatus,
  boardMoveTargets,
  groupEnquiriesForBoard,
} from '../lib/enquiry-board';
import type { Enquiry, StatusTransition } from '../lib/types';

function enquiry(id: string, status: Enquiry['status']): Enquiry {
  return {
    id,
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    client_id: `client-${id}`,
    reference_number: `ENQ-${id}`,
    status,
    intake_state: 'complete',
    intake_error_code: null,
    client_identifier_conflict: false,
    assigned_to: null,
    project_type: null,
    placement: null,
    approximate_size: null,
    cover_up: null,
    preferred_timing: null,
    idea: null,
    source: null,
    utm_source: null,
    created_at: '2026-09-01T09:00:00Z',
    last_action_at: '2026-09-01T09:00:00Z',
    archived_at: null,
  };
}

const TRANSITIONS: StatusTransition[] = [
  { from_status: 'new', to_status: 'reviewing', owner_only: false, note: null },
  { from_status: 'new', to_status: 'waiting_for_client', owner_only: false, note: null },
  { from_status: 'new', to_status: 'accepted', owner_only: true, note: null },
  { from_status: 'new', to_status: 'deposit_paid', owner_only: false, note: null },
  { from_status: 'new', to_status: 'declined', owner_only: false, note: null },
];

describe('enquiry board grouping', () => {
  it('groups active workflow states and leaves closed work off the primary board', () => {
    const grouped = groupEnquiriesForBoard([
      enquiry('1', 'new'),
      enquiry('2', 'reviewing'),
      enquiry('3', 'waiting_for_client'),
      enquiry('4', 'quote_sent'),
      enquiry('5', 'deposit_requested'),
      enquiry('6', 'converted'),
      enquiry('7', 'declined'),
      enquiry('8', 'closed'),
    ]);

    expect(grouped.new.map((row) => row.id)).toEqual(['1', '2']);
    expect(grouped.waiting.map((row) => row.id)).toEqual(['3']);
    expect(grouped.ready.map((row) => row.id)).toEqual(['4']);
    expect(grouped.deposit.map((row) => row.id)).toEqual(['5']);
    expect(grouped.booked.map((row) => row.id)).toEqual(['6']);
    expect(Object.values(grouped).flat().map((row) => row.id)).not.toContain('7');
    expect(Object.values(grouped).flat().map((row) => row.id)).not.toContain('8');
  });

  it('maps the two statuses that share a visual stage to the same column', () => {
    expect(boardColumnForStatus('new')).toBe('new');
    expect(boardColumnForStatus('reviewing')).toBe('new');
    expect(boardColumnForStatus('declined')).toBeNull();
  });
});

describe('enquiry board quick moves', () => {
  it('keeps same-column workflow transitions but excludes ledger and closed-work shortcuts', () => {
    expect(boardMoveTargets(TRANSITIONS, 'new', 'booking_manager')).toEqual([
      'reviewing',
      'waiting_for_client',
    ]);
  });

  it('respects owner-only transitions from the existing role-aware allow-list', () => {
    expect(boardMoveTargets(TRANSITIONS, 'new', 'owner')).toEqual([
      'reviewing',
      'waiting_for_client',
      'accepted',
    ]);
  });

  it('offers no move affordance to a read-only operator', () => {
    expect(boardMoveTargets(TRANSITIONS, 'new', 'read_only')).toEqual([]);
  });
});
