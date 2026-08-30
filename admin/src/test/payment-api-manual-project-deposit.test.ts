import { describe, expect, it, vi } from 'vitest';
import { createPaymentApi } from '../lib/payment-api';
import type { CrmClient } from '../lib/api';

describe('manual project deposit API boundary', () => {
  it('sends project identity and idempotency only, never a browser amount or provider match', async () => {
    const rpc = vi.fn(async (_functionName: string, _params?: Record<string, unknown>) => ({
      data: {
        payment_request_id: 'request-1',
        payment_transaction_id: 'transaction-1',
        amount: 500,
        manually_recorded: 500,
        currency: 'GBP',
        request_created: true,
        already_paid: false,
        replayed: false,
      },
      error: null,
    }));
    const api = createPaymentApi({ rpc } as unknown as CrmClient);

    const result = await api.confirmProjectDepositManually({
      projectId: 'project-1',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-08-30T19:30:00.000Z',
    });

    expect(rpc).toHaveBeenCalledWith('confirm_project_deposit_manually', {
      p_project_id: 'project-1',
      p_idempotency_key: '11111111-1111-4111-8111-111111111111',
      p_occurred_at: '2026-08-30T19:30:00.000Z',
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('p_amount');
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('provider');
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('payment_transaction_id');
    expect(result.manually_recorded).toBe(500);
    expect(result.request_created).toBe(true);
  });
});
