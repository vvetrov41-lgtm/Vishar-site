import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import {
  createWhatsAppConnectionsApi,
  whatsappCrmEnvironment,
  whatsappIntegrationKey,
} from '../lib/whatsapp-connections-api';

const VLADIMIR = {
  id: 'a1111111-1111-4111-8111-111111111111',
  slug: 'vladimir',
  display_name: 'Vladimir',
};

function clientFor(rows: unknown[] = []) {
  const order = vi.fn(async () => ({ data: rows, error: null }));
  const eq = vi.fn((_column: string, _value: string) => ({ order }));
  const select = vi.fn((_columns: string) => ({ eq }));
  const from = vi.fn((_table: string) => ({ select }));
  const rpc = vi.fn(async (_name: string, _args?: Record<string, unknown>) => ({ data: { ok: true }, error: null }));
  const getSession = vi.fn(async () => ({
    data: { session: { access_token: 'browser-session-access-token-for-test' } },
    error: null,
  }));
  return {
    client: { from, rpc, auth: { getSession } } as unknown as CrmClient,
    from,
    select,
    eq,
    order,
    rpc,
    getSession,
  };
}

describe('WhatsApp Connections safety', () => {
  it('derives routing keys only for the two known CRM Supabase environments', () => {
    expect(whatsappCrmEnvironment('https://vfjexhfdbrjmuxfdvbdx.supabase.co')).toBe('production');
    expect(whatsappCrmEnvironment('https://gwaliusblwrzisrwnsvs.supabase.co/')).toBe('staging');
    expect(whatsappIntegrationKey('https://vfjexhfdbrjmuxfdvbdx.supabase.co', 'vladimir')).toBe('vladimir-production');
    expect(whatsappIntegrationKey('https://gwaliusblwrzisrwnsvs.supabase.co', 'kristina')).toBe('kristina-staging');
    expect(() => whatsappIntegrationKey('https://example.supabase.co', 'vladimir')).toThrow(/unavailable/i);
    expect(() => whatsappIntegrationKey('http://127.0.0.1:54321', 'vladimir')).toThrow(/unavailable/i);
    expect(() => whatsappIntegrationKey('https://vfjexhfdbrjmuxfdvbdx.supabase.co', '../kristina')).toThrow(/not valid/i);
  });

  it('reads only safe WhatsApp routing metadata and never configuration', async () => {
    const safeRow = {
      id: 'd1111111-1111-4111-8111-111111111111',
      artist_id: VLADIMIR.id,
      provider: 'meta_cloud_api',
      integration_key: 'vladimir-production',
      external_account_label: 'Vladimir WhatsApp',
      is_enabled: false,
      updated_at: '2026-08-15T09:00:00.000Z',
    };
    const mocks = clientFor([safeRow]);
    const api = createWhatsAppConnectionsApi(mocks.client);

    await expect(api.listWhatsAppIntegrations()).resolves.toEqual([safeRow]);
    expect(mocks.from).toHaveBeenCalledWith('artist_integrations');
    expect(mocks.select).toHaveBeenCalledWith(
      'id, artist_id, provider, integration_key, external_account_label, is_enabled, updated_at',
    );
    expect(mocks.eq).toHaveBeenCalledWith('integration_type', 'whatsapp');
    const projection = mocks.select.mock.calls[0][0];
    expect(projection).not.toContain('configuration');
    expect(projection).not.toContain('credential');
    expect(projection).not.toContain('token');
    expect(projection).not.toContain('secret');
  });

  it('hard-codes WhatsApp provider/type/empty metadata and a deterministic artist key', async () => {
    const mocks = clientFor();
    const api = createWhatsAppConnectionsApi(mocks.client);
    const productionUrl = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';

    await api.prepareWhatsAppIntegration(VLADIMIR, productionUrl);
    expect(mocks.rpc).toHaveBeenLastCalledWith('configure_artist_integration', {
      p_artist_id: VLADIMIR.id,
      p_integration_type: 'whatsapp',
      p_provider: 'meta_cloud_api',
      p_integration_key: 'vladimir-production',
      p_external_account_label: 'Vladimir WhatsApp',
      p_configuration: {},
      p_is_enabled: false,
    });

    await api.setWhatsAppIntegrationEnabled(VLADIMIR, productionUrl, true);
    expect(mocks.rpc).toHaveBeenLastCalledWith('configure_artist_integration', {
      p_artist_id: VLADIMIR.id,
      p_integration_type: 'whatsapp',
      p_provider: 'meta_cloud_api',
      p_integration_key: 'vladimir-production',
      p_external_account_label: 'Vladimir WhatsApp',
      p_configuration: {},
      p_is_enabled: true,
    });
  });

  it('rejects malformed or non-Meta integration rows before the page can render them', async () => {
    const badProvider = clientFor([{
      id: 'd1111111-1111-4111-8111-111111111111',
      artist_id: VLADIMIR.id,
      provider: 'other_provider',
      integration_key: 'vladimir-production',
      external_account_label: null,
      is_enabled: false,
      updated_at: '2026-08-15T09:00:00.000Z',
    }]);
    await expect(createWhatsAppConnectionsApi(badProvider.client).listWhatsAppIntegrations()).rejects.toThrow(
      'Could not load WhatsApp connections',
    );
  });

  it('keeps provider credentials out of database metadata operations', async () => {
    const mocks = clientFor();
    const api = createWhatsAppConnectionsApi(mocks.client);
    expect(Object.keys(api).sort()).toEqual([
      'listWhatsAppIntegrations',
      'prepareWhatsAppIntegration',
      'provisionProductionWhatsApp',
      'setWhatsAppIntegrationEnabled',
    ].sort());

    await api.prepareWhatsAppIntegration(VLADIMIR, 'https://vfjexhfdbrjmuxfdvbdx.supabase.co');
    const call = mocks.rpc.mock.calls[mocks.rpc.mock.calls.length - 1];
    const args = call[1] as Record<string, unknown>;
    expect(args).toMatchObject({
      p_integration_type: 'whatsapp',
      p_provider: 'meta_cloud_api',
      p_integration_key: 'vladimir-production',
      p_configuration: {},
      p_is_enabled: false,
    });
    for (const forbidden of ['token', 'secret', 'waba', 'phone', 'destination', 'credential']) {
      expect(Object.keys(args).some((key) => key.toLowerCase().includes(forbidden))).toBe(false);
    }
  });

  it('posts a completed Vladimir signup only to the same-origin production provision endpoint', async () => {
    const mocks = clientFor();
    const api = createWhatsAppConnectionsApi(mocks.client);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      integration_key: 'vladimir-production',
      waba_name: 'Business account',
      display_phone_number: '+44 7000 000000',
      verified_name: 'Vladimir',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(api.provisionProductionWhatsApp(
      VLADIMIR,
      'https://vfjexhfdbrjmuxfdvbdx.supabase.co',
      {
        authorizationCode: 'one-time-code-for-test',
        wabaId: '12345678901',
        phoneNumberId: '10987654321',
        event: 'FINISH',
      },
    )).resolves.toMatchObject({ ok: true, integration_key: 'vladimir-production' });

    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/whatsapp/embedded-signup/provision');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      artist_id: VLADIMIR.id,
      integration_key: 'vladimir-production',
      code: 'one-time-code-for-test',
      session: { waba_id: '12345678901', phone_number_id: '10987654321' },
    });
    fetchMock.mockRestore();
  });
});
