// The account screen, and the Danger zone on it.
//
// Two things this file is really about. First, that the page is about the
// person and not the business - a studio's name, time zone and currency belong
// to the organization and must not reappear here, because two people in one
// studio share those and share none of this. Second, that deleting an account
// is hard to do by accident and impossible to do on somebody else's behalf.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  MANAGER_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const FOUNDER_MEMBERSHIPS = [
  {
    profile_id: MANAGER_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    access_level: 'artist' as const,
    can_view_finance: true,
    can_manage_finance: true,
    can_manage_sessions: true,
    can_manage_integrations: true,
    is_active: true,
  },
];

function renderAccount(overrides: Record<string, unknown> = {}) {
  return renderWithSession(<App />, {
    role: 'booking_manager',
    membershipOverrides: FOUNDER_MEMBERSHIPS,
    selfServiceFounder: true,
    path: '/account',
    ...overrides,
  } as never);
}

describe('the account page', () => {
  it('shows who you are, using the user-facing role', async () => {
    renderAccount();

    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    // Scoped to the page: the shell prints the same role beside the avatar,
    // and the artist scope control is also called "Artist".
    const page = document.querySelector('.account-page') as HTMLElement;
    expect(within(page).getByDisplayValue('Manager')).toBeInTheDocument();
    expect(within(page).getByText('manager@example.test')).toBeInTheDocument();
    expect(within(page).getByText('Artist')).toBeInTheDocument();
    expect(within(page).queryByText('Booking manager')).not.toBeInTheDocument();
  });

  it('keeps organization settings off it', async () => {
    renderAccount();
    await screen.findByRole('heading', { name: 'Account' });

    for (const label of [/time zone/i, /currency/i, /workspace name/i, /studio name/i]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('saves a new display name through the server', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderAccount({ rpcCalls });
    await screen.findByRole('heading', { name: 'Account' });

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const call = rpcCalls.find((entry) => entry.name === 'set_my_display_name');
    expect(call?.args).toEqual({ p_display_name: 'Sam' });
  });

  it('refuses to save an empty name without asking the server', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderAccount({ rpcCalls });
    await screen.findByRole('heading', { name: 'Account' });

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/enter the name you want shown/i)).toBeInTheDocument();
    expect(rpcCalls.some((entry) => entry.name === 'set_my_display_name')).toBe(false);
  });
});

describe('the danger zone', () => {
  it('says what a founder is actually deleting, and what survives', async () => {
    renderAccount();
    await screen.findByRole('heading', { name: 'Account' });

    expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeInTheDocument();
    expect(screen.getByText(/your artist, your organization/i)).toBeInTheDocument();
    expect(screen.getByText(/activity log keeps a record/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('never deletes on one tap', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderAccount({ rpcCalls });
    await screen.findByRole('heading', { name: 'Account' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(await screen.findByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(rpcCalls.some((entry) => entry.name === 'delete_my_account')).toBe(false);
  });

  it('only enables the confirmation once the account address is typed exactly', async () => {
    renderAccount();
    await screen.findByRole('heading', { name: 'Account' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    const field = screen.getByLabelText(/type manager@example\.test to confirm/i);
    fireEvent.change(field, { target: { value: 'owner@example.test' } });

    expect(screen.getByText(/not the address on this account/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();

    fireEvent.change(field, { target: { value: 'manager@example.test' } });
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeEnabled();
  });

  it('deletes, and ends the session rather than leaving the CRM open', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderAccount({ rpcCalls });
    await screen.findByRole('heading', { name: 'Account' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    fireEvent.change(screen.getByLabelText(/type manager@example\.test to confirm/i), {
      target: { value: 'manager@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => {
      expect(rpcCalls.some((entry) => entry.name === 'delete_my_account')).toBe(true);
    });
    expect(rpcCalls.find((entry) => entry.name === 'delete_my_account')?.args)
      .toEqual({ p_confirmation: 'manager@example.test' });
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('can back out of it', async () => {
    renderAccount();
    await screen.findByRole('heading', { name: 'Account' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep my account' }));

    expect(screen.queryByRole('button', { name: 'Delete permanently' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeInTheDocument();
  });

  it('tells a teammate that their access goes and the artist stays', async () => {
    renderAccount({ selfServiceFounder: false, membershipOverrides: undefined });
    await screen.findByRole('heading', { name: 'Account' });

    expect(screen.getByText(/artist you worked for is untouched/i)).toBeInTheDocument();
  });

  it('offers the installation owner no delete control at all, and says why', async () => {
    renderAccount({ role: 'owner', membershipOverrides: undefined, selfServiceFounder: false });
    await screen.findByRole('heading', { name: 'Account' });

    expect(screen.getByText(/installation owner cannot delete their own account/i))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).not.toBeInTheDocument();
  });
});
