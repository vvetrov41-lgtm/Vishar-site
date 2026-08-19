import { describe, expect, it, vi } from 'vitest';
import { createOAuthConsentApi } from '../lib/oauth-consent-api';
import type { CrmClient } from '../lib/api';

function client(overrides: {
  details?: { data: any; error: any };
  approve?: { data: any; error: any };
  deny?: { data: any; error: any };
  summary?: { data: any; error: any };
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
  const rpc = vi.fn(async () => overrides.summary ?? ({
    data: [{
      integration_key: 'kristina-gpt-actions',
      client_display_name: 'Kristina GPT appointment actions',
      artist_id: 'a2222222-2222-4222-8222-222222222222',
      artist_display_name: 'Kristina Vishar',
      can_read_appointments: true,
      can_manage_appointments: true,
      identity_mode: 'legacy_fixed',
      accessible_artists: [{ key: 'kristina', display_name: 'Kristina Vishar' }],
    }],
    error: null,
  }));

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
          identity_mode: 'legacy_fixed',
          accessible_artists: [{ key: 'kristina', display_name: 'Kristina Vishar' }],
        },
      },
    });
    expect(mock.rpc).toHaveBeenCalledWith('get_gpt_action_consent_summary', {
      p_oauth_client_id: 'oauth-kristina-client',
    });
  });

  it('accepts one unified GPT application with multiple membership-scoped artists', async () => {
    const mock = client({
      summary: {
        data: [{
          integration_key: 'vishar-unified-gpt',
          client_display_name: 'Vishar CRM GPT',
          artist_id: null,
          artist_display_name: 'Multiple artists',
          can_read_appointments: true,
          can_manage_appointments: true,
          identity_mode: 'unified_user',
          accessible_artists: [
            { key: 'kristina', display_name: 'Kristina Vishar' },
            { key: 'vladimir', display_name: 'Vladimir Vishar' },
          ],
        }],
        error: null,
      },
    });

    const result = await createOAuthConsentApi(mock.value).loadGptOAuthConsent('authorization-123');
    expect(result.kind).toBe('consent');
    if (result.kind === 'consent') {
      expect(result.consent.summary.identity_mode).toBe('unified_user');
      expect(result.consent.summary.accessible_artists).toHaveLength(2);
      expect(result.consent.summary.artist_id).toBeNull();
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

    const unknownClient = client({ summary: { data: [], error: null } });
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
