import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import { createPaymentApi } from '../lib/payment-api';

function clientWithRpc(data: unknown = { ok: true }) {
  const rpc = vi.fn(async () => ({ data, error: null }));
  return { client: { rpc } as unknown as CrmClient, rpc };
}

describe('Monzo reconciliation CRM API boundary', () => {
  it('lists candidates only through the artist-scoped safe RPC', async () => {
    const { client, rpc } = clientWithRpc([]);
    const api = createPaymentApi(client);

    await api.listMonzoReconciliationCandidates('artist-1');

    expect(rpc).toHaveBeenCalledWith('list_monzo_reconciliation_candidates', {
      p_artist_id: 'artist-1',
    });
  });

  it('matches through the named non-financial reconciliation RPC', async () => {
    const { client, rpc } = clientWithRpc({
      candidate_id: 'candidate-1',
      status: 'matched',
      payment_request_id: 'request-1',
      confirmed: false,
    });
    const api = createPaymentApi(client);

    await api.matchMonzoReconciliationCandidate({
      candidateId: 'candidate-1',
      paymentRequestId: 'request-1',
    });

    expect(rpc).toHaveBeenCalledWith('match_monzo_reconciliation_candidate', {
      p_candidate_id: 'candidate-1',
      p_payment_request_id: 'request-1',
    });
  });

  it('keeps confirmation as a separate explicit RPC', async () => {
    const { client, rpc } = clientWithRpc({
      candidate_id: 'candidate-1',
      payment_request_id: 'request-1',
      confirmed: true,
      replayed: false,
    });
    const api = createPaymentApi(client);

    await api.confirmMonzoReconciliationCandidate('candidate-1');

    expect(rpc).toHaveBeenCalledWith('confirm_monzo_reconciliation_candidate', {
      p_candidate_id: 'candidate-1',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('ignores through a dedicated RPC without any browser-supplied provider metadata', async () => {
    const { client, rpc } = clientWithRpc({
      candidate_id: 'candidate-1',
      status: 'ignored',
      confirmed: false,
    });
    const api = createPaymentApi(client);

    await api.ignoreMonzoReconciliationCandidate('candidate-1');

    expect(rpc).toHaveBeenCalledWith('ignore_monzo_reconciliation_candidate', {
      p_candidate_id: 'candidate-1',
    });
  });
});
