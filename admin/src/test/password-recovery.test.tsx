import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import {
  passwordRecoveryRedirectUrl,
  requestPasswordRecovery,
  sendPasswordRecoveryEmail,
} from '../lib/password-recovery';
import { RouterProvider } from '../lib/router';
import { SessionProvider } from '../lib/session';
import { authCallbackKind } from '../lib/supabase';
import { createFakeClient } from './fixtures';

vi.mock('../lib/password-recovery', async () => {
  const actual = await vi.importActual<typeof import('../lib/password-recovery')>('../lib/password-recovery');
  return {
    ...actual,
    requestPasswordRecovery: vi.fn(),
  };
});

const requestPasswordRecoveryMock = vi.mocked(requestPasswordRecovery);

describe('password recovery boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem('vishar-crm-language', 'en');
    window.history.replaceState({}, '', '/');
  });

  it('reuses the existing exact password-setup Auth callback', () => {
    const redirect = passwordRecoveryRedirectUrl('https://crm.vishartattoo.com');
    expect(redirect).toBe('https://crm.vishartattoo.com/?staff_invite=1');
    expect(authCallbackKind(redirect)).toBe('staff_invite');
    expect(authCallbackKind(`${redirect}&next=/users`)).toBeNull();
  });

  it('sends the address only to Supabase Auth with the exact recovery redirect', async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ data: {}, error: null });
    await sendPasswordRecoveryEmail(
      { resetPasswordForEmail },
      'artist@example.test',
      'https://crm.vishartattoo.com/?staff_invite=1'
    );

    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      'artist@example.test',
      { redirectTo: 'https://crm.vishartattoo.com/?staff_invite=1' }
    );
  });

  it('does not surface provider detail when the recovery request fails', async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({
      data: {},
      error: { message: 'User not found: synthetic provider detail' },
    });

    await expect(sendPasswordRecoveryEmail(
      { resetPasswordForEmail },
      'unknown@example.test',
      'https://crm.vishartattoo.com/?staff_invite=1'
    )).rejects.toThrow('Could not send the reset email. Wait a minute and try again.');
  });

  it('offers recovery from sign-in and shows the same generic success for the submitted address', async () => {
    requestPasswordRecoveryMock.mockResolvedValue(undefined);
    const client = createFakeClient({ role: 'signed_out' });

    render(
      <SessionProvider client={client}>
        <RouterProvider initialPath="/">
          <App />
        </RouterProvider>
      </SessionProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'artist@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => {
      expect(requestPasswordRecoveryMock).toHaveBeenCalledWith('artist@example.test');
    });
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(/If an account exists for that email/i)).toBeInTheDocument();
  });
});
