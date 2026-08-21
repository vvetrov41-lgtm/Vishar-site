import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createApi } from '../lib/api';
import { createFakeClient, renderWithSession, VLADIMIR_ARTIST_ID } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Team and access management', () => {
  it('keeps the Team route owner-only', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/users' });
    expect(await screen.findByText('Not available for your role')).toBeInTheDocument();

    const managerApi = createApi(createFakeClient({ role: 'booking_manager' }));
    await expect(managerApi.listTeamMemberships()).rejects.toThrow(/permission/i);
  });

  it('shows the existing staff directory and both artist scopes to the owner', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/users' });
    expect(await screen.findByText('Team and artist access')).toBeInTheDocument();
    expect(screen.getAllByText('Vladimir Vishar').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Kristina Vishar').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Role for Manager')).toBeInTheDocument();
  });

  it('saves an artist-scoped capability change through the audited RPC', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'owner', path: '/users', rpcCalls });

    const managerRole = await screen.findByLabelText('Role for Manager');
    const managerCard = managerRole.closest('.team-member-card') as HTMLElement;
    const membershipCard = within(managerCard).getByText('Vladimir Vishar').closest('fieldset') as HTMLElement;

    // The role select renders before the membership read settles, so clicking a
    // toggle straight away races the state update that applies the loaded
    // membership and can silently discard the click. This manager's fixture
    // grants can_manage_sessions, so waiting for that toggle to come back
    // checked is a real "the loaded values are on screen now" signal rather
    // than an arbitrary delay.
    const sessionsToggle = within(membershipCard).getByLabelText('Manage appointments');
    await waitFor(() => expect(sessionsToggle).toBeChecked());

    const integrationsToggle = within(membershipCard).getByLabelText('Manage integrations');
    fireEvent.click(integrationsToggle);
    await waitFor(() => expect(integrationsToggle).toBeChecked());
    fireEvent.click(within(membershipCard).getByRole('button', { name: 'Save artist access' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'upsert_artist_membership');
      expect(call?.args).toMatchObject({
        p_artist_id: VLADIMIR_ARTIST_ID,
        p_can_manage_sessions: true,
        p_can_manage_integrations: true,
      });
    });
  });

  it('invites without exposing Auth or invite secrets to the page', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.role).toBe('booking_manager');
      expect(body.memberships).toHaveLength(1);
      expect(body.memberships[0].artist_id).toBe(VLADIMIR_ARTIST_ID);
      expect(body.memberships[0].can_manage_sessions).toBe(true);
      expect(init.headers).toMatchObject({
        authorization: 'Bearer synthetic.browser.access.token',
      });
      return new Response(JSON.stringify({
        profile_id: '99999999-9999-4999-8999-999999999999',
        role: 'booking_manager',
        is_active: true,
        idempotent_replay: false,
        delivery: 'sent',
        ignored_secret: 'must-not-be-copied',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithSession(<App />, {
      role: 'owner',
      path: '/users',
      teamInviteUrl: 'https://team-api.vishartattoo.com/v1/staff/invite',
    });

    await screen.findByText('Invite a team member');
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new.manager@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Synthetic New Manager' },
    });
    fireEvent.click(screen.getAllByLabelText('Grant access to this artist')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/staff account is provisioned/i)).toBeInTheDocument();
    expect(screen.queryByText(/must-not-be-copied/i)).not.toBeInTheDocument();
  });
});
