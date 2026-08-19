// Reusable destination catalogue and project deposit API boundary.
//
// These prove what the browser is allowed to say. Catalogue administration may
// carry an amount and a URL because the operator is deliberately configuring a
// catalogue entry. A client payment request may carry neither: its amount comes
// from the server-side deposit policy.

import { describe, expect, it, vi } from 'vitest';
import { createPaymentApi } from '../lib/payment-api';
import type { CrmClient } from '../lib/api';

function clientWithRpc(data: unknown = { ok: true }) {
  const rpc = vi.fn(async (..._args: any[]) => ({ data, error: null }));
  const client = { rpc } as unknown as CrmClient;
  return { client, rpc };
}

describe('reusable payment destination catalogue', () => {
  it('configures an arbitrary amount without any special-case handling', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.upsertMonzoPaymentDestination({
      artistId: 'artist-1',
      amount: 625,
      paymentUrl: 'https://monzo.com/pay/r/synthetic-625',
    });

    expect(rpc).toHaveBeenCalledWith('upsert_monzo_payment_destination', {
      p_artist_id: 'artist-1',
      p_amount: 625,
      p_payment_url: 'https://monzo.com/pay/r/synthetic-625',
    });
  });

  it('sends the same shape for a legacy tier amount as for any other amount', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.upsertMonzoPaymentDestination({
      artistId: 'artist-1',
      amount: 50,
      paymentUrl: 'https://monzo.com/pay/r/synthetic-50',
    });
    await api.upsertMonzoPaymentDestination({
      artistId: 'artist-1',
      amount: 1135.5,
      paymentUrl: 'https://monzo.com/pay/r/synthetic-1135-50',
    });

    const first = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = rpc.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    expect(second.p_amount).toBe(1135.5);
  });

  it('never sends an artist-scoped catalogue mutation without an explicit artist', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.archiveMonzoPaymentDestination('destination-1');

    expect(rpc).toHaveBeenCalledWith('archive_monzo_payment_destination', {
      p_destination_id: 'destination-1',
    });
    const payload = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    // The server derives the artist from the destination row, so the browser
    // cannot aim an archive at another artist by restating the scope.
    expect(payload).not.toHaveProperty('p_artist_id');
  });

  it('reads a catalogue that carries fingerprints rather than provider URLs', async () => {
    const { client } = clientWithRpc({
      artist_id: 'artist-1',
      currency: 'GBP',
      destinations: [
        {
          destination_id: 'destination-1',
          amount: 700,
          currency: 'GBP',
          configured: true,
          fingerprint: 'ab12cd34ef56',
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
          issued_request_count: 2,
        },
      ],
    });
    const api = createPaymentApi(client);

    const catalogue = await api.listMonzoPaymentDestinations('artist-1');

    expect(catalogue.destinations).toHaveLength(1);
    expect(JSON.stringify(catalogue)).not.toContain('monzo.com');
    expect(catalogue.destinations[0]).not.toHaveProperty('payment_url');
  });
});

describe('project deposit boundary', () => {
  it('requests a project deposit without stating an amount, artist or policy', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.requestProjectDeposit({
      projectId: 'project-1',
      deliveryChannel: 'copy_link',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    });

    expect(rpc).toHaveBeenCalledWith('request_project_deposit', {
      p_project_id: 'project-1',
      p_idempotency_key: '22222222-2222-4222-8222-222222222222',
      p_delivery_channel: 'copy_link',
    });
    const payload = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('p_amount');
    expect(payload).not.toHaveProperty('p_artist_id');
    expect(payload).not.toHaveProperty('p_policy_id');
    expect(payload).not.toHaveProperty('p_policy_version');
  });

  it('reads the deposit preview from the server instead of recomputing it', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.previewProjectDeposit('project-1');

    expect(rpc).toHaveBeenCalledWith('preview_project_deposit', { p_project_id: 'project-1' });
    const payload = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('p_estimate_total');
    expect(payload).not.toHaveProperty('p_percentage');
  });

  it('sets and clears the authorised override through one named RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.setProjectDepositOverride({ projectId: 'project-1', amount: 980 });
    await api.setProjectDepositOverride({ projectId: 'project-1', amount: null });

    expect(rpc).toHaveBeenNthCalledWith(1, 'set_project_deposit_override', {
      p_project_id: 'project-1',
      p_amount: 980,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'set_project_deposit_override', {
      p_project_id: 'project-1',
      p_amount: null,
    });
  });

  it('configures a policy without letting the browser price a single project', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.configureProjectDepositPolicy({
      artistId: 'artist-1',
      mode: 'percentage_of_estimate',
      percentage: 25,
    });

    expect(rpc).toHaveBeenCalledWith('configure_project_deposit_policy', {
      p_artist_id: 'artist-1',
      p_mode: 'percentage_of_estimate',
      p_fixed_amount: null,
      p_percentage: 25,
      p_minimum_amount: null,
      p_rounding_step: 1,
    });
    const payload = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('p_project_id');
  });
});
