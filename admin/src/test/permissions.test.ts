// Role capability tests.
//
// These assert the shape of the capability matrix itself. What makes them worth
// having is not that the interface hides a button - it is that this matrix is
// the one the interface reads, and drifting from the database's grants would
// mean offering people controls that only ever fail.

import { describe, expect, it } from 'vitest';
import {
  availableTransitions,
  can,
  canAccess,
  canManageArtistFinance,
  canManageArtistSessions,
  capabilitiesFor,
  navItemsFor,
  type Capability,
} from '../lib/permissions';
import type { ArtistMembership } from '../lib/types';
import { TRANSITIONS } from './fixtures';

function membership(overrides: Partial<ArtistMembership> = {}): ArtistMembership {
  return {
    profile_id: 'profile-1',
    artist_id: 'artist-1',
    access_level: 'manager',
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: true,
    can_manage_integrations: false,
    is_active: true,
    ...overrides,
  };
}

describe('capabilities', () => {
  it('gives the owner every capability', () => {
    const owner = capabilitiesFor('owner');
    const manager = capabilitiesFor('booking_manager');
    const reader = capabilitiesFor('read_only');

    for (const capability of [...manager, ...reader]) {
      expect(owner).toContain(capability);
    }
  });

  it('withholds finance from a booking manager unless their artist membership grants it', () => {
    expect(can('booking_manager', 'viewFinance')).toBe(false);
    expect(can('booking_manager', 'manageFinance')).toBe(false);
    expect(canAccess('booking_manager', 'viewFinance')).toBe(false);
    expect(canAccess('booking_manager', 'manageFinance')).toBe(false);
    expect(canAccess('booking_manager', 'viewFinance', [membership({ can_view_finance: true })])).toBe(true);
    expect(canAccess('booking_manager', 'manageFinance', [membership({ can_manage_finance: true })])).toBe(true);
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
      'transitionEnquiry', 'assignEnquiry', 'convertEnquiry',
      'manageProjects', 'manageSessions', 'manageFinance', 'createNotes',
      'manageFollowUps', 'createEmailDraft', 'approveEmail', 'manageIntegrations', 'manageNotifications',
      'manageUsers', 'manageSettings',
    ];
    for (const capability of writes) {
      expect(can('read_only', capability)).toBe(false);
    }
  });

  it('gives read_only no file, note, email, activity or integration access', () => {
    for (const capability of ['viewEnquiryFiles', 'viewNotes', 'viewActivity', 'viewIntegrationJobs', 'manageIntegrations'] as Capability[]) {
      expect(can('read_only', capability)).toBe(false);
    }
  });

  it('gives a null role nothing', () => {
    expect(capabilitiesFor(null)).toEqual([]);
    expect(can(null, 'viewEnquiries')).toBe(false);
    expect(can(undefined, 'viewClients')).toBe(false);
  });

  it('keeps the manager out of integration jobs while allowing only scoped integration management', () => {
    expect(can('owner', 'viewIntegrationJobs')).toBe(true);
    expect(can('booking_manager', 'viewIntegrationJobs')).toBe(false);
    expect(can('booking_manager', 'manageIntegrations')).toBe(true);
    expect(canAccess('booking_manager', 'manageIntegrations')).toBe(false);
    expect(canAccess('booking_manager', 'manageIntegrations', [membership({ can_manage_integrations: true })])).toBe(true);
  });
});

describe('navigation', () => {
  it('shows the owner every section', () => {
    const paths = navItemsFor('owner').map((item) => item.path);
    expect(paths).toEqual([
      '/',
      '/inbox',
      '/enquiries',
      '/clients',
      '/follow-ups',
      '/projects',
      '/appointments',
      '/availability',
      '/statistics',
      '/automations',
      '/invoices',
      '/payments',
      '/integrations',
      '/notifications',
      // No '/workspaces': workspace authority is not expressible from CrmRole,
      // so AppShell appends that entry from the server's answer instead.
      '/users',
      '/activity',
    ]);
  });

  it('hides scoped sections from a booking manager until a membership grants them', () => {
    const paths = navItemsFor('booking_manager').map((item) => item.path);
    expect(paths).not.toContain('/payments');
    expect(paths).not.toContain('/invoices');
    expect(paths).not.toContain('/integrations');
    expect(paths).not.toContain('/users');
    expect(paths).toContain('/enquiries');
    expect(paths).toContain('/availability');
    expect(paths).toContain('/automations');
    expect(paths).toContain('/activity');
  });

  it('shows Payments for a booking manager with finance membership but keeps Calendar hidden', () => {
    const paths = navItemsFor('booking_manager', [membership({
      can_view_finance: true,
      can_manage_finance: true,
      can_manage_integrations: false,
    })]).map((item) => item.path);
    expect(paths).toContain('/payments');
    // Invoices follow view_finance, so a membership that can only look still
    // gets the list without the Payments screen's write controls.
    expect(paths).toContain('/invoices');
    expect(paths).not.toContain('/integrations');
  });

  it('shows Invoices to a membership that may view finance but not manage it', () => {
    const paths = navItemsFor('booking_manager', [membership({
      can_view_finance: true,
      can_manage_finance: false,
    })]).map((item) => item.path);
    expect(paths).toContain('/invoices');
    expect(paths).not.toContain('/payments');
  });

  it('shows the integrations hub for a booking manager with integration membership', () => {
    const paths = navItemsFor('booking_manager', [membership({ can_manage_integrations: true })]).map((item) => item.path);
    expect(paths).toContain('/integrations');
    // Calendar, WhatsApp and Instagram are reached through the hub now, so
    // they are deliberately no longer navigation peers.
    expect(paths).not.toContain('/integrations/whatsapp');
    expect(paths).not.toContain('/integrations/instagram');
  });

  it('leaves read_only with viewing sections only', () => {
    const paths = navItemsFor('read_only').map((item) => item.path);
    // The notification centre is reachable by everyone: it shows only the
    // signed-in profile's own rows, so there is nothing here for a role to
    // widen.
    expect(paths).toEqual([
      '/', '/inbox', '/enquiries', '/clients', '/follow-ups', '/projects', '/appointments', '/availability',
      // Statistics counts the same enquiries, projects and sessions a read-only
      // role already reads, so it is offered to that role too. Its money block
      // is not: the database returns no finance rows to a read-only viewer.
      '/statistics',
      '/automations', '/notifications',
    ]);
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

describe('who may set one artist session price', () => {
  it('lets the owner manage price for any artist', () => {
    expect(canManageArtistFinance('owner', [], 'artist-1')).toBe(true);
  });

  it('requires the matching active finance membership for a booking manager', () => {
    expect(canManageArtistFinance(
      'booking_manager',
      [membership({ can_manage_finance: true })],
      'artist-1'
    )).toBe(true);
    expect(canManageArtistFinance(
      'booking_manager',
      [membership({ artist_id: 'artist-2', can_manage_finance: true })],
      'artist-1'
    )).toBe(false);
    expect(canManageArtistFinance(
      'booking_manager',
      [membership({ can_manage_finance: true, is_active: false })],
      'artist-1'
    )).toBe(false);
  });

  it('never gives price editing to read-only access', () => {
    expect(canManageArtistFinance(
      'read_only',
      [membership({ can_manage_finance: true })],
      'artist-1'
    )).toBe(false);
  });
});

describe('who may move one artist schedule', () => {
  it('lets the owner move any artist appointments', () => {
    expect(canManageArtistSessions('owner', [], 'artist-1')).toBe(true);
  });

  it('lets a manager move the schedule their membership allows', () => {
    expect(canManageArtistSessions('booking_manager', [membership()], 'artist-1')).toBe(true);
  });

  it('refuses a manager whose membership cannot manage sessions', () => {
    expect(canManageArtistSessions(
      'booking_manager',
      [membership({ can_manage_sessions: false })],
      'artist-1'
    )).toBe(false);
  });

  it('refuses a manager holding another artist only', () => {
    expect(canManageArtistSessions(
      'booking_manager',
      [membership({ artist_id: 'artist-2' })],
      'artist-1'
    )).toBe(false);
  });

  it('refuses a deactivated membership and read_only outright', () => {
    expect(canManageArtistSessions(
      'booking_manager',
      [membership({ is_active: false })],
      'artist-1'
    )).toBe(false);
    expect(canManageArtistSessions('read_only', [membership()], 'artist-1')).toBe(false);
    expect(canManageArtistSessions(null, [membership()], 'artist-1')).toBe(false);
  });
});
