import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLanguage } from '../lib/i18n';
import {
  beginEmbeddedSignupRedirect,
  setCapturedEmbeddedSignupCallbackForTest,
} from '../lib/meta-whatsapp-signup-redirect';
import { useSession } from '../lib/session';
import { WhatsAppConnectionsPage } from '../pages/WhatsAppConnectionsPage';

vi.mock('../lib/session', () => ({ useSession: vi.fn() }));
vi.mock('../lib/i18n', () => ({ useLanguage: vi.fn() }));
vi.mock('../lib/router', () => ({
  Link: ({ to, children }: any) => <a href={to}>{children}</a>,
}));
vi.mock('../lib/meta-whatsapp-signup-redirect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/meta-whatsapp-signup-redirect')>()),
  beginEmbeddedSignupRedirect: vi.fn(),
}));

const PRODUCTION_SUPABASE = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const KRISTINA = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'kristina',
  display_name: 'Kristina',
  is_active: true,
};
const VLADIMIR = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'vladimir',
  display_name: 'Vladimir',
  is_active: true,
};

function sessionFor() {
  const api = {
    listAccessibleArtists: vi.fn(async () => [KRISTINA, VLADIMIR]),
    listWhatsAppIntegrations: vi.fn(async () => [{
      id: 'integration-kristina',
      artist_id: KRISTINA.id,
      provider: 'meta_cloud_api',
      integration_key: 'kristina-production',
      external_account_label: 'Kristina WhatsApp',
      is_enabled: true,
      connected_at: '2026-10-10T10:00:00.000Z',
      updated_at: '2026-10-10T10:00:00.000Z',
    }]),
    provisionProductionWhatsApp: vi.fn(async () => ({
      ok: true,
      connected: true,
      integration_key: 'kristina-production',
      verified_name: 'Kristina',
      display_phone_number: '+44 7507 262327',
    })),
  };
  vi.mocked(useSession).mockReturnValue({
    api,
    profile: { id: 'p1', role: 'booking_manager', is_active: true, display_name: 'Manager' },
    // The manager may manage Kristina's integrations only.
    memberships: [{
      profile_id: 'p1',
      artist_id: KRISTINA.id,
      access_level: 'manager',
      can_view_finance: false,
      can_manage_finance: false,
      can_manage_sessions: true,
      can_manage_integrations: true,
      is_active: true,
    }],
  } as any);
  return api;
}

describe('WhatsApp connections page, CRM-owned Meta redirect', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', PRODUCTION_SUPABASE);
    vi.mocked(useLanguage).mockReturnValue({ language: 'en' } as any);
    vi.mocked(beginEmbeddedSignupRedirect).mockReset();
  });

  afterEach(() => {
    setCapturedEmbeddedSignupCallbackForTest(null);
    vi.unstubAllEnvs();
  });

  it('starts Coexistence by navigating this tab, without the JS SDK', async () => {
    const api = sessionFor();
    render(<WhatsAppConnectionsPage />);
    const connect = await screen.findByRole('button', { name: /Connect Kristina WhatsApp Business app \(Coexistence\)/ });
    expect(connect).not.toBeDisabled();
    fireEvent.click(connect);
    expect(beginEmbeddedSignupRedirect).toHaveBeenCalledWith(KRISTINA.id);
    expect(api.provisionProductionWhatsApp).not.toHaveBeenCalled();
  });

  it('exchanges the returned code exactly once, for the artist the flow started for', async () => {
    const api = sessionFor();
    setCapturedEmbeddedSignupCallbackForTest({ status: 'code', artistId: KRISTINA.id, code: 'AQD-one-time-code' });
    const { rerender } = render(<WhatsAppConnectionsPage />);

    expect(await screen.findByText(/Kristina WhatsApp connected/)).toBeInTheDocument();
    rerender(<WhatsAppConnectionsPage />);
    await waitFor(() => expect(api.listAccessibleArtists.mock.calls.length).toBeGreaterThan(1));
    expect(api.provisionProductionWhatsApp).toHaveBeenCalledTimes(1);
    expect(api.provisionProductionWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: KRISTINA.id }),
      PRODUCTION_SUPABASE,
      {
        authorizationCode: 'AQD-one-time-code',
        wabaId: null,
        phoneNumberId: null,
        event: 'CODE_ONLY',
        redirectFlow: 'crm_root',
      },
    );
  });

  it('never exchanges a refused callback', async () => {
    const api = sessionFor();
    setCapturedEmbeddedSignupCallbackForTest({ status: 'rejected', reason: 'state_mismatch' });
    render(<WhatsAppConnectionsPage />);
    expect(await screen.findByText(/state_mismatch/)).toBeInTheDocument();
    expect(api.provisionProductionWhatsApp).not.toHaveBeenCalled();
  });

  it('never exchanges a code for an artist this session cannot manage', async () => {
    const api = sessionFor();
    setCapturedEmbeddedSignupCallbackForTest({ status: 'code', artistId: VLADIMIR.id, code: 'AQD-one-time-code' });
    render(<WhatsAppConnectionsPage />);
    expect(await screen.findByText(/artist this session cannot manage/)).toBeInTheDocument();
    expect(api.provisionProductionWhatsApp).not.toHaveBeenCalled();
  });

  it('reports a Meta cancellation without an exchange', async () => {
    const api = sessionFor();
    setCapturedEmbeddedSignupCallbackForTest({ status: 'cancelled', artistId: KRISTINA.id });
    render(<WhatsAppConnectionsPage />);
    expect(await screen.findByText(/connection was cancelled in Meta/)).toBeInTheDocument();
    expect(api.provisionProductionWhatsApp).not.toHaveBeenCalled();
  });
});
