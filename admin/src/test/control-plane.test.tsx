// The organization and artist administration screens.
//
// These tests are about the three things this surface can get wrong in a way a
// look at the page would not catch:
//
//   * offering a control that the database is certain to refuse — a bootstrap
//     seat on an artist that already has a team, a capability a global role
//     forbids, a right the reader does not hold themselves;
//   * mistaking "you may not read this" for "there is nothing here", which
//     turns a permission boundary into an empty screen that looks broken;
//   * quietly implying that administering an organization lets you open an
//     artist's work, which is the one thing the whole platform is built to
//     prevent.

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import { App } from '../App';
import {
  NEW_ARTIST_ID,
  STUDIO_WORKSPACE_ID,
  renderWithSession,
  type ControlPlaneArtist,
  type ControlPlaneArtistContext,
  type ControlPlaneArtistMembership,
  type ControlPlaneCapability,
  type ControlPlaneDirectoryProfile,
  type ControlPlaneWorkspace,
} from './fixtures';

const MANAGER_PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const READER_PROFILE_ID = '33333333-3333-4333-8333-333333333333';

/** What public.control_plane_access() answers for somebody who administers the
 *  studio below. Nothing in the interface may derive this from the legacy role. */
const FULL_ACCESS = {
  workspace_count: 1,
  administers_any: true,
  can_manage_any_team: true,
  can_found_workspace: true,
  can_browse_directory: true,
};

const DIRECTORY: ControlPlaneDirectoryProfile[] = [
  {
    id: MANAGER_PROFILE_ID,
    display_name: 'Booking Manager',
    email: 'manager@example.test',
    profile_role: 'booking_manager',
    can_hold_artist_writes: true,
  },
  {
    id: READER_PROFILE_ID,
    display_name: 'Read Only Person',
    email: 'reader@example.test',
    profile_role: 'read_only',
    // The legacy role forbids every write, so the one-shot seat must not be
    // spent here.
    can_hold_artist_writes: false,
  },
];

function artistContext(
  overrides: Partial<ControlPlaneArtistContext> = {},
): ControlPlaneArtistContext {
  return {
    artist_id: NEW_ARTIST_ID,
    artist_slug: 'artist-z',
    artist_display_name: 'Artist Z',
    artist_timezone: 'Europe/London',
    artist_default_currency: 'GBP',
    artist_is_active: true,
    member_count: 0,
    active_booking_sources: 0,
    enabled_integrations: 0,
    workspace_id: STUDIO_WORKSPACE_ID,
    workspace_display_name: 'Ink Collective',
    workspace_type: 'studio',
    viewer_can_administer: true,
    viewer_has_artist_membership: false,
    viewer_can_manage_team: true,
    ...overrides,
  };
}

const STUDIO: ControlPlaneWorkspace = {
  id: STUDIO_WORKSPACE_ID,
  slug: 'ink-collective',
  display_name: 'Ink Collective',
  workspace_type: 'studio',
  timezone: 'Europe/London',
  default_currency: 'GBP',
  is_active: true,
  workspace_role: 'owner',
  can_manage_workspace: true,
  can_manage_team: true,
  can_manage_integrations: true,
  artist_count: 1,
};

function artist(overrides: Partial<ControlPlaneArtist> = {}): ControlPlaneArtist {
  return {
    id: NEW_ARTIST_ID,
    slug: 'artist-z',
    display_name: 'Artist Z',
    timezone: 'Europe/London',
    default_currency: 'GBP',
    is_active: true,
    member_count: 0,
    active_booking_sources: 0,
    enabled_integrations: 0,
    viewer_has_membership: false,
    created_at: '2026-08-23T09:00:00Z',
    ...overrides,
  };
}

function membership(
  overrides: Partial<ControlPlaneArtistMembership> = {},
): ControlPlaneArtistMembership {
  return {
    profile_id: '22222222-2222-4222-8222-222222222222',
    display_name: 'Booking Manager',
    email: 'manager@example.test',
    profile_is_active: true,
    profile_role: 'booking_manager',
    access_level: 'manager',
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: true,
    can_manage_integrations: false,
    is_active: true,
    grant_source: 'explicit',
    ...overrides,
  };
}

const CAPABILITIES: ControlPlaneCapability[] = [
  { capability: 'view_enquiries', domain: 'enquiries', is_write: false,
    description: 'Read enquiries.', granted: true },
  { capability: 'manage_sessions', domain: 'sessions', is_write: true,
    description: 'Create, reschedule and cancel appointments.', granted: true },
  { capability: 'view_finance', domain: 'finance', is_write: false,
    description: 'Read deposits, payment requests and the payment ledger.', granted: false },
  { capability: 'manage_finance', domain: 'finance', is_write: true,
    description: 'Issue, cancel and reconcile payments.', granted: false },
];

function studioSession(extra: Record<string, unknown> = {}) {
  return {
    role: 'owner' as const,
    workspaces: [STUDIO],
    workspaceArtists: { [STUDIO_WORKSPACE_ID]: [artist()] },
    workspaceTeam: { [STUDIO_WORKSPACE_ID]: [] },
    artistMemberships: { [NEW_ARTIST_ID]: [] },
    artistContexts: { [NEW_ARTIST_ID]: artistContext() },
    capabilityPreview: CAPABILITIES,
    controlPlaneAccess: FULL_ACCESS,
    directory: DIRECTORY,
    ...extra,
  };
}

describe('organizations', () => {
  it('lists the organizations a profile belongs to', async () => {
    renderWithSession(<App />, { ...studioSession(), path: '/workspaces' });

    expect(await screen.findByText('Ink Collective')).toBeInTheDocument();
    expect(screen.getByText(/artists: 1/)).toBeInTheDocument();
  });

  it('says nothing is there rather than looking broken when a profile has none', async () => {
    renderWithSession(<App />, {
      ...studioSession({ workspaces: [], controlPlaneAccess: FULL_ACCESS }),
      path: '/workspaces',
    });

    expect(await screen.findByText('No organizations')).toBeInTheDocument();
  });

  // The list used to show "Управление" / "Admin" as a decorative chip. It reads
  // as an instruction, sits where a control sits, and did nothing when tapped.
  it('offers a real, keyboard-reachable route from the list to the management screen', async () => {
    renderWithSession(<App />, { ...studioSession(), path: '/workspaces' });

    const manage = await screen.findByRole('link', { name: 'Manage' });
    expect(manage).toHaveAttribute('href', `#/workspaces/${STUDIO_WORKSPACE_ID}`);

    // The organization name is the other way in, and both land in one place.
    const title = screen.getByRole('link', { name: 'Ink Collective' });
    expect(title).toHaveAttribute('href', `#/workspaces/${STUDIO_WORKSPACE_ID}`);

    fireEvent.click(manage);
    expect(await screen.findByText('Artist Z')).toBeInTheDocument();
  });

  it('shows no management action to somebody who may not administer the organization', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        workspaces: [{ ...STUDIO, can_manage_workspace: false }],
      }),
      path: '/workspaces',
    });

    await screen.findByText('Ink Collective');
    expect(screen.queryByRole('link', { name: 'Manage' })).not.toBeInTheDocument();
    // A right the reader does hold stays a plain label, not a second route in.
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
  });

  it('offers founding an organization only when the server authorizes it', async () => {
    const { unmount } = renderWithSession(<App />, {
      ...studioSession({
        controlPlaneAccess: { ...FULL_ACCESS, can_found_workspace: true },
      }),
      path: '/workspaces',
    });
    expect(await screen.findByRole('button', { name: 'New organization' })).toBeInTheDocument();
    unmount();

    renderWithSession(<App />, {
      ...studioSession({
        controlPlaneAccess: { ...FULL_ACCESS, can_found_workspace: false },
      }),
      path: '/workspaces',
    });
    await screen.findByText('Ink Collective');
    expect(screen.queryByRole('button', { name: 'New organization' })).not.toBeInTheDocument();
  });
});

describe('the artist roster', () => {
  it('shows an artist the reader administers but cannot open, and says so', async () => {
    renderWithSession(<App />, {
      ...studioSession(),
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });

    expect(await screen.findByText('Artist Z')).toBeInTheDocument();
    // The honest label. Administering the organization is not access to the
    // artist's work, and the screen must not imply otherwise.
    expect(screen.getByText('You cannot open their work')).toBeInTheDocument();
    expect(screen.getByText('Nobody has access')).toBeInTheDocument();
  });

  it('adds an artist through the named RPC, sending no slug or identifier', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      ...studioSession(),
      rpcCalls,
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Add artist' }));
    const form = screen.getByLabelText('Artist name').closest('form')!;
    fireEvent.change(screen.getByLabelText('Artist name'), { target: { value: 'Artist Q' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'create_artist')).toBe(true);
    });
    const call = rpcCalls.find((entry) => entry.name === 'create_artist')!;
    expect(call.args).toMatchObject({
      p_workspace_id: STUDIO_WORKSPACE_ID,
      p_display_name: 'Artist Q',
      // Derived server-side. The browser never invents an address.
      p_slug: null,
      p_booking_reference_prefix: null,
    });
  });

  it('refuses to offer a second artist in a solo organization', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        workspaces: [{ ...STUDIO, workspace_type: 'solo' }],
      }),
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });

    await screen.findByText('Artist Z');
    expect(screen.queryByRole('button', { name: 'Add artist' })).not.toBeInTheDocument();
    expect(screen.getByText(/A solo organization holds one artist/)).toBeInTheDocument();
  });

  it('collapses the staff list rather than erroring when the reader may not read it', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        workspaces: [{ ...STUDIO, can_manage_team: false }],
      }),
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });

    await screen.findByText('Artist Z');
    expect(screen.queryByRole('heading', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the onboarding checklist', () => {
  it('names the one step that actually blocks the artist', async () => {
    renderWithSession(<App />, { ...studioSession(), path: `/artists/${NEW_ARTIST_ID}` });

    const step = await screen.findByText('Who can reach them');
    const row = step.closest('li')!;
    expect(within(row).getByText('Needed')).toBeInTheDocument();
    expect(within(row).getByText('Nobody can open this artist yet')).toBeInTheDocument();
  });

  it('marks connected services as needing an outside step, never as required', async () => {
    renderWithSession(<App />, { ...studioSession(), path: `/artists/${NEW_ARTIST_ID}` });

    const row = (await screen.findByText('Connected services')).closest('li')!;
    // The distinction the brief asks for: a provider approval is not something
    // the person reading this failed to do, and calling it "Needed" would send
    // them looking for a button that does not exist.
    expect(within(row).getByText('Needs an outside step')).toBeInTheDocument();
  });

  it('reports the artist ready once somebody holds an artist-level seat', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        workspaceArtists: { [STUDIO_WORKSPACE_ID]: [artist({ member_count: 1 })] },
        artistMemberships: { [NEW_ARTIST_ID]: [membership({ access_level: 'artist' })] },
      }),
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    expect(await screen.findByText(/This artist is ready to work/)).toBeInTheDocument();
  });
});

describe('the bootstrap seat', () => {
  it('is offered while the artist has no team at all', async () => {
    renderWithSession(<App />, { ...studioSession(), path: `/artists/${NEW_ARTIST_ID}` });

    expect(await screen.findByRole('heading', { name: 'Who is this artist' })).toBeInTheDocument();
  });

  it('is withheld the moment anybody holds a membership, because the database would refuse', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        artistMemberships: { [NEW_ARTIST_ID]: [membership()] },
      }),
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    await screen.findByRole('heading', { name: 'Access to this artist' });
    expect(screen.queryByRole('heading', { name: 'Who is this artist' })).not.toBeInTheDocument();
  });

  it('calls the named RPC with the person and the artist', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      ...studioSession(),
      rpcCalls,
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    await screen.findByRole('heading', { name: 'Who is this artist' });
    const select = screen.getAllByLabelText('Person')[0];
    fireEvent.change(select, { target: { value: '22222222-2222-4222-8222-222222222222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give them access' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'seat_artist_owner')).toBe(true);
    });
    expect(rpcCalls.find((call) => call.name === 'seat_artist_owner')!.args).toMatchObject({
      p_profile_id: '22222222-2222-4222-8222-222222222222',
      p_artist_id: NEW_ARTIST_ID,
    });
  });
});

describe('the capability editor', () => {
  it('reports what a grant allows from the server, not from a browser rule', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      ...studioSession({
        artistMemberships: { [NEW_ARTIST_ID]: [membership()] },
      }),
      rpcCalls,
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Change access' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'preview_membership_capabilities')).toBe(true);
    }, { timeout: 3000 });

    // Granted capabilities are shown by their own description, which is the
    // registry's text — not a label this component invented.
    expect(await screen.findByText('Create, reschedule and cancel appointments.'))
      .toBeInTheDocument();
    // Withheld ones are not claimed.
    expect(screen.queryByText('Issue, cancel and reconcile payments.')).not.toBeInTheDocument();
  });

  it('sends the grant, never a capability list, when saving', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      ...studioSession({
        artistMemberships: { [NEW_ARTIST_ID]: [membership()] },
      }),
      rpcCalls,
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    const card = (await screen.findByRole('button', { name: 'Change access' })).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Change access' }));
    fireEvent.click(await within(card).findByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'grant_workspace_artist_membership')).toBe(true);
    });
    const call = rpcCalls.find((entry) => entry.name === 'grant_workspace_artist_membership')!;
    expect(Object.keys(call.args ?? {}).sort()).toEqual([
      'p_access_level',
      'p_artist_id',
      'p_can_manage_finance',
      'p_can_manage_integrations',
      'p_can_manage_sessions',
      'p_can_view_finance',
      'p_is_active',
      'p_profile_id',
    ]);
  });

  it('keeps managing money and seeing money in step, because the database will', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        artistMemberships: { [NEW_ARTIST_ID]: [membership()] },
      }),
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Change access' }));

    const manageMoney = screen.getByLabelText('Manage money') as HTMLInputElement;
    const seeMoney = screen.getByLabelText('See money') as HTMLInputElement;
    fireEvent.click(manageMoney);

    await waitFor(() => {
      expect(seeMoney.checked).toBe(true);
    });
  });

  it('explains why the person is on this artist, from the record rather than a guess', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        artistMemberships: {
          [NEW_ARTIST_ID]: [membership({ grant_source: 'workspace_grant' })],
        },
      }),
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    expect(await screen.findByText('Granted by the organization')).toBeInTheDocument();
  });
});

describe('no secret reaches the browser', () => {
  it('renders no credential-shaped text on either control-plane screen', async () => {
    const { container, unmount } = renderWithSession(<App />, {
      ...studioSession(),
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });
    await screen.findByText('Artist Z');
    expect(container.textContent ?? '').not.toMatch(
      /token|secret|api[_-]?key|chat_id|bearer|sb_secret|service_role/i,
    );
    unmount();

    const artistScreen = renderWithSession(<App />, {
      ...studioSession(),
      path: `/artists/${NEW_ARTIST_ID}`,
    });
    await screen.findByRole('heading', { name: 'Access to this artist' });
    expect(artistScreen.container.textContent ?? '').not.toMatch(
      /token|secret|api[_-]?key|chat_id|bearer|sb_secret|service_role/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Regressions from the independent review of the first control-plane pass.
// Each of these is a defect that shipped and was found by reading rather than
// by a failing test, which is exactly the gap these close.
// ---------------------------------------------------------------------------

describe('the people directory is scoped, not owner-only', () => {
  it('offers people to a workspace administrator who is not the installation owner', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      // A booking_manager, deliberately: the legacy global owner is exactly
      // what the control plane must stop depending on.
      ...studioSession({ role: 'booking_manager' as const }),
      rpcCalls,
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });

    expect(await screen.findByLabelText('Add a person')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Booking Manager' })).toBeInTheDocument();

    // The scoped read, never public.list_profiles() — which requires the
    // legacy global owner role and would have returned nothing here.
    expect(rpcCalls.some((call) => call.name === 'list_directory_profiles')).toBe(true);
    expect(rpcCalls.some((call) => call.name === 'list_profiles')).toBe(false);
  });
});

describe('the workspace owner row', () => {
  const ownerRow = {
    profile_id: '11111111-1111-4111-8111-111111111111',
    display_name: 'Studio Owner',
    email: 'owner@example.test',
    profile_is_active: true,
    profile_role: 'booking_manager' as const,
    workspace_role: 'owner' as const,
    can_manage_workspace: true,
    can_manage_team: true,
    can_manage_integrations: true,
    membership_is_active: true,
    artist_access_count: 0,
  };

  it('offers no control the backend would refuse', async () => {
    renderWithSession(<App />, {
      ...studioSession({ workspaceTeam: { [STUDIO_WORKSPACE_ID]: [ownerRow] } }),
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });

    const card = (await screen.findByText('Studio Owner')).closest('article')!;
    // No role select, no active checkbox, no save: upsert_workspace_membership
    // refuses to write over an owner row, so a form here could only fail.
    expect(within(card).queryByLabelText('Role')).not.toBeInTheDocument();
    expect(within(card).queryByLabelText('Active')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(card).getByText(/Ownership moves only through a deliberate transfer/))
      .toBeInTheDocument();
  });

  it('still edits an ordinary member normally', async () => {
    renderWithSession(<App />, {
      ...studioSession({
        workspaceTeam: {
          [STUDIO_WORKSPACE_ID]: [{ ...ownerRow, workspace_role: 'admin' as const }],
        },
      }),
      path: `/workspaces/${STUDIO_WORKSPACE_ID}`,
    });

    const card = (await screen.findByText('Studio Owner')).closest('article')!;
    expect(within(card).getByLabelText('Role')).toBeInTheDocument();
    // And `owner` is never an option, because granting it here is refused.
    expect(within(card).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
  });
});

describe('control-plane navigation is server-driven', () => {
  it('is offered to a read_only profile that the server says administers a workspace', async () => {
    // The case the legacy CrmRole got backwards: read_only in the old model
    // meant "no administration anywhere", which locked this person out of the
    // organization they genuinely run.
    renderWithSession(<App />, {
      ...studioSession({ role: 'read_only' as const }),
      path: '/workspaces',
    });

    expect(await screen.findByText('Ink Collective')).toBeInTheDocument();
  });

  it('is withheld from a booking_manager the server places in no organization', async () => {
    // The other direction: the old model showed this person a nav entry to an
    // empty page purely because of their global role.
    renderWithSession(<App />, {
      role: 'booking_manager',
      controlPlaneAccess: null,
      path: '/workspaces',
    });

    expect(await screen.findByText('No organization yet')).toBeInTheDocument();
    expect(screen.queryByText('Ink Collective')).not.toBeInTheDocument();
  });
});

describe('the artist page reaches the artist themselves', () => {
  it('opens for somebody holding only an artist membership and no workspace right', async () => {
    // A freshly seated artist in a studio: seat_artist_owner grants an artist
    // membership and no workspace membership, on purpose. The page used to
    // resolve the artist by walking the viewer's workspaces, so it told them
    // they had no access to their own onboarding.
    renderWithSession(<App />, {
      ...studioSession({
        role: 'booking_manager' as const,
        workspaces: [],
        controlPlaneAccess: null,
        artistContexts: {
          [NEW_ARTIST_ID]: artistContext({
            viewer_can_administer: false,
            viewer_has_artist_membership: true,
            viewer_can_manage_team: true,
            member_count: 1,
          }),
        },
        artistMemberships: { [NEW_ARTIST_ID]: [membership({ access_level: 'artist' })] },
      }),
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    expect(await screen.findByRole('heading', { name: 'Artist Z' })).toBeInTheDocument();
    expect(screen.getByText('What is left to do')).toBeInTheDocument();
    // Their organization is named for context but not offered as a link: they
    // hold no workspace right, so following it would only reach a refusal.
    expect(screen.getByText('Ink Collective')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ink Collective/ })).not.toBeInTheDocument();
  });

  it('resolves through one server read rather than walking every workspace', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      ...studioSession(),
      rpcCalls,
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    await screen.findByRole('heading', { name: 'Artist Z' });
    expect(rpcCalls.some((call) => call.name === 'artist_control_plane_context')).toBe(true);
  });
});

describe('the capability preview follows the person, not just the checkboxes', () => {
  it('refetches when the subject changes although the grant shape is identical', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      ...studioSession({
        artistMemberships: {
          [NEW_ARTIST_ID]: [membership({ profile_id: 'aaaa1111-1111-4111-8111-111111111111' })],
        },
        artistContexts: {
          [NEW_ARTIST_ID]: artistContext({ member_count: 1 }),
        },
        capabilityPreviewByProfile: {
          [MANAGER_PROFILE_ID]: [{
            capability: 'manage_sessions', domain: 'sessions', is_write: true,
            description: 'Create, reschedule and cancel appointments.', granted: true,
          }],
          [READER_PROFILE_ID]: [{
            capability: 'manage_sessions', domain: 'sessions', is_write: true,
            description: 'Create, reschedule and cancel appointments.', granted: false,
          }],
        },
      }),
      rpcCalls,
      path: `/artists/${NEW_ARTIST_ID}`,
    });

    // The grant flags are never touched between the two selections, so the old
    // effect key could not tell these two people apart.
    const picker = await screen.findByLabelText('Person');
    fireEvent.change(picker, { target: { value: MANAGER_PROFILE_ID } });

    expect(await screen.findByText('Create, reschedule and cancel appointments.'))
      .toBeInTheDocument();

    fireEvent.change(picker, { target: { value: READER_PROFILE_ID } });

    await waitFor(() => {
      const asked = rpcCalls.filter((call) => call.name === 'preview_membership_capabilities');
      expect(asked.some((call) => call.args?.p_profile_id === READER_PROFILE_ID)).toBe(true);
    }, { timeout: 3000 });

    // And the first person's answer is gone rather than lingering under the
    // second person's name.
    await waitFor(() => {
      expect(screen.queryByText('Create, reschedule and cancel appointments.'))
        .not.toBeInTheDocument();
    }, { timeout: 3000 });
  });
});

describe('the one-shot artist seat', () => {
  it('refuses to be spent on a profile whose CRM role forbids every write', async () => {
    renderWithSession(<App />, { ...studioSession(), path: `/artists/${NEW_ARTIST_ID}` });

    await screen.findByRole('heading', { name: 'Who is this artist' });
    const picker = screen.getAllByLabelText('Person')[0];
    fireEvent.change(picker, { target: { value: READER_PROFILE_ID } });

    expect(await screen.findByText(/read-only CRM user and could not change anything/))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Give them access' })).toBeDisabled();
  });

  it('stays available for an eligible person', async () => {
    renderWithSession(<App />, { ...studioSession(), path: `/artists/${NEW_ARTIST_ID}` });

    await screen.findByRole('heading', { name: 'Who is this artist' });
    const picker = screen.getAllByLabelText('Person')[0];
    fireEvent.change(picker, { target: { value: MANAGER_PROFILE_ID } });

    expect(screen.getByRole('button', { name: 'Give them access' })).not.toBeDisabled();
  });
});
