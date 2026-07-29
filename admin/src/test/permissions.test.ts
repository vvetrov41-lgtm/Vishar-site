// Role capability tests.
//
// These assert the shape of the capability matrix itself. What makes them worth
// having is not that the interface hides a button — it is that this matrix is
// the one the interface reads, and drifting from the database's grants would
// mean offering people controls that only ever fail.

import { describe, expect, it } from 'vitest';
import {
  availableTransitions,
  can,
  capabilitiesFor,
  navItemsFor,
  type Capability,
} from '../lib/permissions';
import { TRANSITIONS } from './fixtures';

describe('capabilities', () => {
  it('gives the owner every capability', () => {
    const owner = capabilitiesFor('owner');
    const manager = capabilitiesFor('booking_manager');
    const reader = capabilitiesFor('read_only');

    for (const capability of [...manager, ...reader]) {
      expect(owner).toContain(capability);
    }
  });

  it('withholds finance from a booking manager', () => {
    expect(can('booking_manager', 'viewFinance')).toBe(false);
    expect(can('booking_manager', 'manageFinance')).toBe(false);
    expect(can('owner', 'viewFinance')).toBe(true);
  });

  it('withholds user management and settings from anyone but the owner', () => {
    for (const capability of ['manageUsers', 'manageSettings'] as Capability[]) {
      expect(can('owner', capability)).toBe(true);
      expect(can('booking_manager', capability)).toBe(false);
      expect(can('read_only', capability)).toBe(false);
    }
  });

  it('lets only the owner approve an email', () => {
    expect(can('owner', 'approveEmail')).toBe(true);
    expect(can('booking_manager', 'createEmailDraft')).toBe(true);
    expect(can('booking_manager', 'approveEmail')).toBe(false);
    expect(can('read_only', 'createEmailDraft')).toBe(false);
  });

  it('gives read_only no write capability at all', () => {
    const writes: Capability[] = [
      'editClientContact', 'transitionEnquiry', 'assignEnquiry', 'convertEnquiry',
      'manageProjects', 'manageSessions', 'manageFinance', 'createNotes',
      'manageFollowUps', 'createEmailDraft', 'approveEmail', 'manageUsers', 'manageSettings',
    ];
    for (const capability of writes) {
      expect(can('read_only', capability)).toBe(false);
    }
  });

  it('gives read_only no file, note, email, activity or integration access', () => {
    for (const capability of ['viewEnquiryFiles', 'viewNotes', 'viewActivity', 'viewIntegrationJobs'] as Capability[]) {
      expect(can('read_only', capability)).toBe(false);
    }
  });

  it('gives a null role nothing', () => {
    expect(capabilitiesFor(null)).toEqual([]);
    expect(can(null, 'viewEnquiries')).toBe(false);
    expect(can(undefined, 'viewClients')).toBe(false);
  });

  it('keeps the manager out of integration jobs', () => {
    expect(can('owner', 'viewIntegrationJobs')).toBe(true);
    expect(can('booking_manager', 'viewIntegrationJobs')).toBe(false);
  });
});

describe('navigation', () => {
  it('shows the owner every section', () => {
    const paths = navItemsFor('owner').map((item) => item.path);
    expect(paths).toEqual(['/', '/enquiries', '/clients', '/projects', '/sessions', '/users', '/activity']);
  });

  it('hides Users from a booking manager but keeps their working sections', () => {
    const paths = navItemsFor('booking_manager').map((item) => item.path);
    expect(paths).not.toContain('/users');
    expect(paths).toContain('/enquiries');
    expect(paths).toContain('/activity');
  });

  it('leaves read_only with viewing sections only', () => {
    const paths = navItemsFor('read_only').map((item) => item.path);
    expect(paths).toEqual(['/', '/enquiries', '/clients', '/projects', '/sessions']);
  });

  it('shows nothing at all without an active profile', () => {
    expect(navItemsFor(null)).toEqual([]);
  });
});

describe('status transitions', () => {
  it('offers a manager only the transitions they may perform', () => {
    const options = availableTransitions(TRANSITIONS, 'new', 'booking_manager');
    expect(options.map((option) => option.to_status)).toEqual(['reviewing', 'declined']);
  });

  it('withholds an owner-only transition from a manager', () => {
    const options = availableTransitions(TRANSITIONS, 'declined', 'booking_manager');
    expect(options).toEqual([]);
  });

  it('offers the owner-only transition to the owner', () => {
    const options = availableTransitions(TRANSITIONS, 'declined', 'owner');
    expect(options.map((option) => option.to_status)).toEqual(['reviewing']);
  });

  it('offers read_only nothing', () => {
    expect(availableTransitions(TRANSITIONS, 'new', 'read_only')).toEqual([]);
    expect(availableTransitions(TRANSITIONS, 'new', null)).toEqual([]);
  });
});
