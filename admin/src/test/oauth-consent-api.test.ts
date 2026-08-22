import { describe, expect, it, vi } from 'vitest';
import { createOAuthConsentApi } from '../lib/oauth-consent-api';
import type { CrmClient } from '../lib/api';

const LEGACY_DETAILS = {
  integration_key: 'kristina-gpt-actions',
  client_display_name: 'Kristina GPT appointment actions',
  binding_mode: 'artist',
  artist_id: 'a2222222-2222-4222-8222-222222222222',
  artist_display_name: 'Kristina Vishar',
  artist_count: 1,
  can_read_appointments: true,
  can_manage_appointments: true,
};

const UNIFIED_DETAILS = {
  integration_key: 'vishar-unified-gpt',
  client_display_name: 'Vishar CRM unified GPT',
  binding_mode: 'profile',
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  artist_display_name: null,
  artist_count: 2,
  can_read_appointments: true,
  can_manage_appointments: true,
};

function client(overrides: {
  details?: { data: any; error: any };
  approve?: { data: any; error: any };
  deny?: { data: any; error: any };
  summary?: { data: any; error: any };
  consentDetails?: { data: any; error: any };
} = {}) {
  const getAuthorizationDetails = vi.fn(async () => overrides.details ?? ({
    data: {
      authorization_id: 'authorization-123',
      client: { id: 'oauth-kristina-client', name: 'Kristina Private GPT' },
      scope: 'email',
    },
    error: null,
  }));
  const approveAuthorization = vi.fn(async () => overrides.approve ?? ({
    data: { redirect_url: 'https://chatgpt.com/aip/callback?code=approved' },
    error: null,
  }));
  const denyAuthorization = vi.fn(async () => overrides.deny ?? ({
    data: { redirect_url: 'https://chatgpt.com/aip/callback?error=denied' },
    error: null,
  }));
  // The browser must ask for exactly the two named consent RPCs and nothing
  // else, so the mock refuses any other name rather than answering it.
  const rpc = vi.fn(async (name: string) => {
    if (name === 'get_gpt_consent_details') {
      return overrides.consentDetails ?? { data: { ...LEGACY_DETAILS }, error: null };
    }
    if (name === 'get_gpt_action_consent_summary') {
      return overrides.summary ?? ({
        data: [{
          integration_key: 'kristina-gpt-actions',
          client_display_name: 'Kristina GPT appointment actions',
          artist_id: 'a2222222-2222-4222-8222-222222222222',
          artist_display_name: 'Kristina Vishar',
          can_read_appointments: true,
          can_manage_appointments: true,
        }],
        error: null,
      });
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  return {
    value: {
      rpc,
      auth: {
        oauth: {
          getAuthorizationDetails,
          approveAuthorization,
          denyAuthorization,
        },
      },
    } as unknown as CrmClient,
    getAuthorizationDetails,
    approveAuthorization,
    denyAuthorization,
    rpc,
  };
}

describe('GPT OAuth consent API', () => {
  it('loads only a database-approved fixed-artist GPT client', async () => {
    const mock = client();
    const api = createOAuthConsentApi(mock.value);

    await expect(api.loadGptOAuthConsent('authorization-123')).resolves.toEqual({
      kind: 'consent',
      consent: {
        authorizationId: 'authorization-123',
        requestedClientName: 'Kristina Private GPT',
        scopes: ['email'],
        summary: {
          integration_key: 'kristina-gpt-actions',
          client_display_name: 'Kristina GPT appointment actions',
          artist_id: 'a2222222-2222-4222-8222-222222222222',
          artist_display_name: 'Kristina Vishar',
          can_read_appointments: true,
          can_manage_appointments: true,
        },
        details: {
          integration_key: 'kristina-gpt-actions',
          client_display_name: 'Kristina GPT appointment actions',
          binding_mode: 'artist',
          artist_display_name: 'Kristina Vishar',
          artist_count: 1,
          can_read_appointments: true,
          can_manage_appointments: true,
        },
      },
    });
    expect(mock.rpc).toHaveBeenCalledWith('get_gpt_consent_details', {
      p_oauth_client_id: 'oauth-kristina-client',
    });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it('describes a profile-bound GPT by its membership boundary, not by an artist', async () => {
    const mock = client({ consentDetails: { data: { ...UNIFIED_DETAILS }, error: null } });
    const result = await createOAuthConsentApi(mock.value).loadGptOAuthConsent('authorization-123');

    if (result.kind !== 'consent') throw new Error('expected a consent result');
    expect(result.consent.details).toEqual({
      integration_key: 'vishar-unified-gpt',
      client_display_name: 'Vishar CRM unified GPT',
      binding_mode: 'profile',
      artist_display_name: null,
      artist_count: 2,
      can_read_appointments: true,
      can_manage_appointments: true,
    });
    // The legacy six-column shape stays populated for any older consumer, and
    // says plainly that the scope is the profile's memberships.
    expect(result.consent.summary.artist_display_name)
      .toBe('Artists available to your CRM profile');
  });

  it('falls back to the legacy summary only when the detail RPC is unavailable', async () => {
    const mock = client({
      consentDetails: { data: null, error: { message: 'function does not exist' } },
    });
    const result = await createOAuthConsentApi(mock.value).loadGptOAuthConsent('authorization-123');

    if (result.kind !== 'consent') throw new Error('expected a consent result');
    expect(result.consent.details).toBeNull();
    expect(result.consent.summary.artist_display_name).toBe('Kristina Vishar');
    expect(mock.rpc).toHaveBeenNthCalledWith(1, 'get_gpt_consent_details', {
      p_oauth_client_id: 'oauth-kristina-client',
    });
    expect(mock.rpc).toHaveBeenNthCalledWith(2, 'get_gpt_action_consent_summary', {
      p_oauth_client_id: 'oauth-kristina-client',
    });
  });

  it('refuses a malformed consent detail instead of falling back or guessing', async () => {
    const malformed = [
      { ...UNIFIED_DETAILS, binding_mode: 'workspace' },
      { ...UNIFIED_DETAILS, binding_mode: undefined },
      // A profile-bound GPT that names an artist would tell the human it is
      // fixed to that artist. It is not.
      { ...UNIFIED_DETAILS, artist_display_name: 'Vladimir' },
      // A fixed-artist GPT that names none would hide which artist it reaches.
      { ...LEGACY_DETAILS, artist_display_name: null },
      { ...LEGACY_DETAILS, artist_count: 0 },
      { ...LEGACY_DETAILS, can_manage_appointments: 'true' },
      [LEGACY_DETAILS],
      null,
    ];

    for (const data of malformed) {
      const mock = client({ consentDetails: { data, error: null } });
      await expect(
        createOAuthConsentApi(mock.value).loadGptOAuthConsent('authorization-123'),
      ).rejects.toThrow('not enabled for your CRM access');
      // A refused detail must not quietly fall through to the legacy RPC.
      expect(mock.rpc).toHaveBeenCalledTimes(1);
    }
  });

  it('uses the validated redirect when consent was already granted', async () => {
    const mock = client({
      details: {
        data: { redirect_url: 'https://chatgpt.com/aip/callback?code=existing' },
        error: null,
      },
    });
    const api = createOAuthConsentApi(mock.value);

    await expect(api.loadGptOAuthConsent('authorization-123')).resolves.toEqual({
      kind: 'redirect',
      redirectUrl: 'https://chatgpt.com/aip/callback?code=existing',
    });
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('rejects unexpected scopes and unknown OAuth clients', async () => {
    const unexpectedScope = client({
      details: {
        data: {
          authorization_id: 'authorization-123',
          client: { id: 'oauth-kristina-client', name: 'Kristina Private GPT' },
          scope: 'openid email',
        },
        error: null,
      },
    });
    await expect(
      createOAuthConsentApi(unexpectedScope.value).loadGptOAuthConsent('authorization-123'),
    ).rejects.toThrow('unexpected OAuth scope');

    const unknownClient = client({
      consentDetails: { data: null, error: { message: 'not enabled' } },
      summary: { data: [], error: null },
    });
    await expect(
      createOAuthConsentApi(unknownClient.value).loadGptOAuthConsent('authorization-123'),
    ).rejects.toThrow('not enabled for your CRM access');
  });

  it('rejects malformed authorization IDs before any network call', async () => {
    const mock = client();
    await expect(
      createOAuthConsentApi(mock.value).loadGptOAuthConsent('bad id'),
    ).rejects.toThrow('invalid or has expired');
    expect(mock.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('approves or denies only to a safe HTTPS redirect', async () => {
    const mock = client();
    const api = createOAuthConsentApi(mock.value);
    await expect(
      api.decideGptOAuthConsent('authorization-123', 'approve'),
    ).resolves.toBe('https://chatgpt.com/aip/callback?code=approved');
    await expect(
      api.decideGptOAuthConsent('authorization-123', 'deny'),
    ).resolves.toBe('https://chatgpt.com/aip/callback?error=denied');

    const unsafe = client({
      approve: {
        data: { redirect_url: 'http://example.test/callback?code=bad' },
        error: null,
      },
    });
    await expect(
      createOAuthConsentApi(unsafe.value).decideGptOAuthConsent('authorization-123', 'approve'),
    ).rejects.toThrow('safe redirect');
  });
});
