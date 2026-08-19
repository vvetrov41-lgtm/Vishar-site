import { describe, expect, it, vi } from 'vitest';
import { createPaymentApi } from '../lib/payment-api';
import type { CrmClient } from '../lib/api';

function clientWithRpc() {
  const rpc = vi.fn(async (..._args: any[]) => ({ data: { ok: true }, error: null }));
  const client = { rpc } as unknown as CrmClient;
  return { client, rpc };
}

describe('project payment API boundary', () => {
  it('creates a deposit request through the server-owned duration policy', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.requestSessionDeposit({
      sessionId: 'appointment-1',
      deliveryChannel: 'copy_link',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });

    expect(rpc).toHaveBeenCalledWith('request_session_deposit', {
      p_session_id: 'appointment-1',
      p_idempotency_key: '11111111-1111-4111-8111-111111111111',
      p_delivery_channel: 'copy_link',
    });
  });

  it('creates a multiple-session request without accepting browser-authored artist or amount', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.requestGroupedSessionDeposit({
      sessionIds: ['appointment-1', 'appointment-2'],
      deliveryChannel: 'copy_link',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    });

    expect(rpc).toHaveBeenCalledWith('request_grouped_session_deposit', {
      p_session_ids: ['appointment-1', 'appointment-2'],
      p_idempotency_key: '33333333-3333-4333-8333-333333333333',
      p_delivery_channel: 'copy_link',
    });
    const payload = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('p_artist_id');
    expect(payload).not.toHaveProperty('p_amount');
    expect(payload).not.toHaveProperty('p_project_id');
  });

  it('attaches a one-off Monzo URL without allowing the browser to supply artist or amount', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.attachMonzoOneOffPaymentDestination({
      paymentRequestId: 'request-1',
      paymentUrl: 'https://monzo.com/pay/r/synthetic-oneoff',
    });

    expect(rpc).toHaveBeenCalledWith('attach_monzo_one_off_payment_destination', {
      p_payment_request_id: 'request-1',
      p_payment_url: 'https://monzo.com/pay/r/synthetic-oneoff',
    });
  });

  it('records manual money through the immutable payment ledger RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.recordManualPayment({
      paymentRequestId: 'request-1',
      amount: 250,
      occurredAt: '2026-08-17T20:00:00.000Z',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    });

    expect(rpc).toHaveBeenCalledWith('record_manual_payment', {
      p_payment_request_id: 'request-1',
      p_idempotency_key: '22222222-2222-4222-8222-222222222222',
      p_amount: 250,
      p_occurred_at: '2026-08-17T20:00:00.000Z',
      p_safe_note_code: 'crm_manual_payment',
    });
  });

  it('cancels an unpaid request through the canonical cancellation RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPaymentApi(client);

    await api.cancelPaymentRequest('request-1');

    expect(rpc).toHaveBeenCalledWith('cancel_payment_request', {
      p_payment_request_id: 'request-1',
    });
  });
});
