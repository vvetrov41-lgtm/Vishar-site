// The OAuth consent screen has to tell a human the truth about what they are
// authorizing, and there are now two different truths.
//
// A GPT bound to one artist is fixed to that artist and must name it. The
// shared Vishar GPT is fixed to no artist at all: it works as the signed-in
// CRM user and reaches only the artists that user is authorized for. Rendering
// the second one with the first one's wording would tell the human something
// false about their own data, so the mode is taken from the database contract
// and never guessed.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { GptConsentLoadResult, PendingGptConsent } from '../lib/oauth-consent-api';

const mocks = vi.hoisted(() => {
  const loadGptOAuthConsent = vi.fn();
  const decideGptOAuthConsent = vi.fn();
  const signOut = vi.fn();
  // The session value has to be referentially stable. The page re-runs its
  // load effect whenever `api` changes identity, so a fresh object per render
  // would leave the screen loading forever and hide every assertion below.
  const session = {
    api: { loadGptOAuthConsent, decideGptOAuthConsent },
    profile: { display_name: 'Sam Manager' },
    signOut,
  };
  return { loadGptOAuthConsent, decideGptOAuthConsent, signOut, session };
});

const loadGptOAuthConsent = mocks.loadGptOAuthConsent as unknown as {
  mockResolvedValue: (value: GptConsentLoadResult) => void;
  mockRejectedValue: (value: unknown) => void;
  mock: { calls: unknown[] };
};

vi.mock('../lib/session', () => ({ useSession: () => mocks.session }));

const { OAuthConsentPage } = await import('../pages/OAuthConsentPage');

function consent(overrides: Partial<PendingGptConsent> = {}): PendingGptConsent {
  return {
    authorizationId: 'authorization-123',
    requestedClientName: 'Vishar Private GPT',
    scopes: ['email'],
    summary: {
      integration_key: 'vladimir-gpt-actions',
      client_display_name: 'Vladimir GPT appointment actions',
      artist_id: 'a1111111-1111-4111-8111-111111111111',
      artist_display_name: 'Vladimir Vishar',
      can_read_appointments: true,
      can_manage_appointments: true,
    },
    details: {
      integration_key: 'vladimir-gpt-actions',
      client_display_name: 'Vladimir GPT appointment actions',
      binding_mode: 'artist',
      artist_display_name: 'Vladimir Vishar',
      artist_count: 1,
      can_read_appointments: true,
      can_manage_appointments: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/oauth/consent?authorization_id=authorization-123');
});

describe('GPT OAuth consent screen', () => {
  it('names the one artist a legacy GPT is fixed to', async () => {
    loadGptOAuthConsent.mockResolvedValue({ kind: 'consent', consent: consent() });
    render(<OAuthConsentPage />);

    await screen.findByText('Fixed artist scope');
    expect(screen.getByText('Vladimir Vishar', { selector: 'dd' })).toBeTruthy();
    expect(screen.queryByText(/Artists available through your CRM memberships/)).toBeNull();
    expect(screen.getByText(/cannot switch artist/)).toBeTruthy();
  });

  it('describes a profile-bound GPT by membership, and never claims a fixed artist', async () => {
    loadGptOAuthConsent.mockResolvedValue({
      kind: 'consent',
      consent: consent({
        summary: {
          integration_key: 'vishar-unified-gpt',
          client_display_name: 'Vishar CRM unified GPT',
          artist_id: 'a1111111-1111-4111-8111-111111111111',
          artist_display_name: 'Artists available to your CRM profile',
          can_read_appointments: true,
          can_manage_appointments: true,
        },
        details: {
          integration_key: 'vishar-unified-gpt',
          client_display_name: 'Vishar CRM unified GPT',
          binding_mode: 'profile',
          artist_display_name: null,
          artist_count: 2,
          can_read_appointments: true,
          can_manage_appointments: true,
        },
      }),
    });
    render(<OAuthConsentPage />);

    await screen.findByText('Artist access');
    expect(screen.queryByText('Fixed artist scope')).toBeNull();
    expect(screen.getByText(/Artists available through your CRM memberships/)).toBeTruthy();
    expect(screen.getByText('2 artists you are currently authorized for')).toBeTruthy();
    expect(screen.getByText(/only to an artist you are authorized to access/)).toBeTruthy();
    // The boundary must not be described as fixed, and no artist may be named.
    expect(screen.queryByText(/cannot switch artist/)).toBeNull();
    expect(screen.queryByText('Vladimir Vishar', { selector: 'dd' })).toBeNull();
  });

  it('falls back to the narrower fixed-artist wording when the mode is unknown', async () => {
    loadGptOAuthConsent.mockResolvedValue({
      kind: 'consent',
      consent: consent({ details: null }),
    });
    render(<OAuthConsentPage />);

    await screen.findByText('Fixed artist scope');
    expect(screen.queryByText(/Artists available through your CRM memberships/)).toBeNull();
  });

  it('fails closed when the consent request cannot be loaded', async () => {
    loadGptOAuthConsent.mockRejectedValue(new Error('nope'));
    render(<OAuthConsentPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/invalid, expired, or not available/);
    expect(screen.queryByText('Approve access')).toBeNull();
    expect(screen.queryByText('Fixed artist scope')).toBeNull();
    expect(screen.queryByText('Artist access')).toBeNull();
  });

  it('never calls the CRM without an authorization id', async () => {
    window.history.replaceState({}, '', '/oauth/consent');
    render(<OAuthConsentPage />);

    await screen.findByRole('alert');
    await waitFor(() => expect(mocks.loadGptOAuthConsent).not.toHaveBeenCalled());
  });
});
