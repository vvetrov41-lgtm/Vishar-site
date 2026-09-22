import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SessionProvider, useSession } from '../lib/session';
import { RouterProvider } from '../lib/router';
import { SurfaceProvider } from '../lib/surface';
import { OwnerTwoFactorBanner } from '../components/OwnerTwoFactorBanner';
import {
  needsChallenge,
  normaliseCode,
  startEnrollment,
  verifyCode,
  type MfaAuth,
  type MfaFactor,
} from '../lib/mfa';
import { createFakeClient } from './fixtures';

function fakeMfa(options: { factors: MfaFactor[]; level?: 'aal1' | 'aal2'; validCode?: string }) {
  const state = { level: options.level ?? 'aal1', factors: [...options.factors] };
  const mfa: MfaAuth & { calls: string[] } = {
    calls: [],
    getAuthenticatorAssuranceLevel: vi.fn(async () => ({
      data: {
        currentLevel: state.level,
        nextLevel: state.factors.some((factor) => factor.status === 'verified') ? 'aal2' : 'aal1',
      },
      error: null,
    })),
    listFactors: vi.fn(async () => ({ data: { totp: state.factors }, error: null })),
    enroll: vi.fn(async () => ({
      data: { id: 'new-factor', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'SECRET', uri: 'otpauth://x' } },
      error: null,
    })),
    challengeAndVerify: vi.fn(async ({ factorId, code }: { factorId: string; code: string }) => {
      mfa.calls.push(`${factorId}:${code}`);
      if (code !== (options.validCode ?? '123456')) return { data: null, error: { message: 'invalid' } };
      state.level = 'aal2';
      return { data: {}, error: null };
    }),
    unenroll: vi.fn(async ({ factorId }: { factorId: string }) => {
      state.factors = state.factors.filter((factor) => factor.id !== factorId);
      return { data: {}, error: null };
    }),
  };
  return mfa;
}

const VERIFIED: MfaFactor = { id: 'phone', status: 'verified', friendly_name: 'Phone' };
const BACKUP: MfaFactor = { id: 'backup', status: 'verified', friendly_name: 'Backup' };

function Probe() {
  const { state, verifyMfa, mfaEnrolled } = useSession();
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="enrolled">{String(mfaEnrolled)}</span>
      <button type="button" onClick={() => { void verifyMfa('123 456').catch(() => {}); }}>verify</button>
      <OwnerTwoFactorBanner />
    </div>
  );
}

function renderProbe(mfa: MfaAuth, currentProfile = vi.fn()) {
  const client = createFakeClient({ role: 'owner' });
  (client.auth as { mfa?: MfaAuth }).mfa = mfa;
  const from = client.from.bind(client);
  client.from = (table: string) => {
    if (table === 'profiles') currentProfile(table);
    return from(table);
  };
  render(
    <SurfaceProvider surface="internal">
      <SessionProvider client={client}>
        <RouterProvider initialPath="/"><Probe /></RouterProvider>
      </SessionProvider>
    </SurfaceProvider>
  );
  return { currentProfile };
}

describe('two-factor library', () => {
  it('accepts only six digits, ignoring spaces', () => {
    expect(normaliseCode('123 456')).toBe('123456');
    expect(normaliseCode('12345')).toBeNull();
    expect(normaliseCode('abcdef')).toBeNull();
  });

  it('asks for a challenge only for an enrolled aal1 session', async () => {
    expect(await needsChallenge(fakeMfa({ factors: [VERIFIED] }))).toBe(true);
    expect(await needsChallenge(fakeMfa({ factors: [VERIFIED], level: 'aal2' }))).toBe(false);
    expect(await needsChallenge(fakeMfa({ factors: [] }))).toBe(false);
  });

  it('tries every verified authenticator so a backup device works', async () => {
    const mfa = fakeMfa({ factors: [VERIFIED, BACKUP] });
    (mfa.challengeAndVerify as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ data: null, error: { message: 'x' } }));
    await verifyCode(mfa, '123456');
    expect(mfa.challengeAndVerify).toHaveBeenCalledTimes(2);
  });

  it('never sends a malformed code to Supabase', async () => {
    const mfa = fakeMfa({ factors: [VERIFIED] });
    await expect(verifyCode(mfa, '12')).rejects.toThrow('invalid_code_format');
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
  });

  it('clears abandoned, unverified enrolments before starting a new one', async () => {
    const mfa = fakeMfa({ factors: [VERIFIED, { id: 'stale', status: 'unverified' }] });
    const enrollment = await startEnrollment(mfa, 'Authenticator 2');
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: 'stale' });
    expect(mfa.unenroll).not.toHaveBeenCalledWith({ factorId: 'phone' });
    expect(enrollment.factorId).toBe('new-factor');
  });
});

describe('two-factor session gate', () => {
  it('holds an enrolled password-only session at the challenge without reading CRM data', async () => {
    const { currentProfile } = renderProbe(fakeMfa({ factors: [VERIFIED] }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('mfa_challenge'));
    expect(currentProfile).not.toHaveBeenCalled();
  });

  it('opens the CRM once the code verifies', async () => {
    renderProbe(fakeMfa({ factors: [VERIFIED] }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('mfa_challenge'));
    await act(async () => { screen.getByText('verify').click(); });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('active'));
    expect(screen.getByTestId('enrolled').textContent).toBe('true');
  });

  it('leaves an account without a factor unchanged and reminds the owner', async () => {
    renderProbe(fakeMfa({ factors: [] }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('active'));
    expect(screen.getByTestId('enrolled').textContent).toBe('false');
    expect(screen.getByRole('status').textContent).toMatch(/two-factor|двухфактор/i);
  });
});
