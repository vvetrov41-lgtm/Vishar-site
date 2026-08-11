import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import type { CrmClient } from '../lib/api';
import { RouterProvider } from '../lib/router';
import { SessionProvider } from '../lib/session';
import { createFakeClient, type FakeClientOptions } from './fixtures';

const PASSWORD = 'Synthetic-Strong-Password-42!';

type AuthCall = { method: string; passwordLength?: number };

function renderInviteSession(
  role: FakeClientOptions['role'],
  staffInviteMode: boolean,
) {
  const authCalls: AuthCall[] = [];
  const client = createFakeClient({ role });
  const auth = client.auth as CrmClient['auth'] & {
    updateUser: (attributes: { password: string }) => Promise<{ data: unknown; error: unknown }>;
  };
  const originalGetSession = auth.getSession;
  let signedOut = false;

  auth.getSession = async () => (
    signedOut
      ? { data: { session: null }, error: null }
      : originalGetSession()
  );
  auth.updateUser = async ({ password }) => {
    authCalls.push({ method: 'updateUser', passwordLength: password.length });
    return { data: {}, error: null };
  };
  auth.signOut = async () => {
    authCalls.push({ method: 'signOut' });
    signedOut = true;
    return { error: null };
  };

  render(
    <SessionProvider client={client} staffInviteMode={staffInviteMode}>
      <RouterProvider initialPath="/">
        <App />
      </RouterProvider>
    </SessionProvider>
  );

  return { authCalls };
}

describe('invited staff first-login flow', () => {
  beforeEach(() => {
    window.localStorage.setItem('vishar-crm-language', 'en');
    window.history.replaceState({}, '', '/');
  });

  it('requires an active invited staff member to set a password before CRM access', async () => {
    window.history.replaceState({}, '', '/?staff_invite=1#synthetic-auth-fragment');
    const { authCalls } = renderInviteSession('booking_manager', true);

    expect(await screen.findByRole('heading', { name: 'Set your CRM password' })).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => {
      expect(authCalls).toEqual([
        { method: 'updateUser', passwordLength: PASSWORD.length },
        { method: 'signOut' },
      ]);
    });
    expect(authCalls.some((call) => Object.values(call).includes(PASSWORD))).toBe(false);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('does not allow a mismatched password to reach Supabase Auth', async () => {
    const { authCalls } = renderInviteSession('booking_manager', true);

    await screen.findByRole('heading', { name: 'Set your CRM password' });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: `${PASSWORD}x` } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(authCalls).toEqual([]);
  });

  it('does not offer password setup to an invited Auth user with no active CRM profile', async () => {
    renderInviteSession('no_profile', true);

    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Set your CRM password' })).not.toBeInTheDocument();
  });

  it('keeps ordinary active staff sessions on the normal CRM path', async () => {
    renderInviteSession('booking_manager', false);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Set your CRM password' })).not.toBeInTheDocument();
    });
    expect((await screen.findAllByText('Dashboard')).length).toBeGreaterThan(0);
  });
});
