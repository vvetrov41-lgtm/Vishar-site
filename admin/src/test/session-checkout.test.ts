import { describe, expect, it } from 'vitest';
import type { InvoiceDocument } from '../lib/invoice-api';
import type { ProjectPaymentRequest } from '../lib/payment-api';
import { calculateSessionCheckout } from '../lib/session-checkout';

const sessionId = 'session-1';
const payment = (overrides: Partial<ProjectPaymentRequest> = {}): ProjectPaymentRequest => ({
  id: 'deposit-one',
  session_id: sessionId,
  purpose: 'deposit',
  amount: 250,
  currency: 'GBP',
  status: 'paid',
  created_at: '2026-10-01T10:00:00Z',
  net_paid: 250,
  outstanding_amount: 0,
  ...overrides,
});

function invoice(overrides: {
  sessionIds?: Array<string | null>;
  amountPaid?: number;
  remaining?: number;
  status?: 'issued' | 'paid' | 'partially_paid' | 'draft' | 'void';
  paymentRequestId?: string;
  currency?: string;
} = {}): InvoiceDocument {
  return {
    invoice: {
      id: 'invoice-one',
      artist_id: 'artist-one',
      client_id: 'client-one',
      project_id: 'project-one',
      invoice_number: 'INV-1',
      status: overrides.status ?? 'paid',
      currency: overrides.currency ?? 'GBP',
      issue_date: '2026-10-27',
      due_date: '2026-10-27',
      created_at: '2026-10-27T10:00:00Z',
      updated_at: '2026-10-27T10:00:00Z',
      subtotal: 730,
      discount_amount: 0,
      total: 730,
      amount_paid: overrides.amountPaid ?? 730,
      amount_credited: 0,
      amount_outstanding: overrides.remaining ?? 0,
      is_overdue: false,
      notes: null,
      void_reason: null,
    },
    artist: { id: 'artist-one', display_name: 'Vladimir', legal_name: null, timezone: 'Europe/London' },
    client: { id: 'client-one', full_name: 'Charlie', email: null, phone: null },
    project: { id: 'project-one', title: 'Test' },
    line_items: (overrides.sessionIds ?? [sessionId]).map((id, index) => ({
      id: String(index),
      session_id: id,
      line_position: index + 1,
      description: 'Session',
      quantity: 1,
      unit_amount: 730,
      line_total: 730,
    })),
    payments: overrides.amountPaid === 0 ? [] : [{
      payment_request_id: overrides.paymentRequestId ?? 'balance-one',
      payment_transaction_id: 'transaction-one',
      purpose: 'additional_payment',
      transaction_type: 'manual',
      direction: 'credit',
      amount: overrides.amountPaid ?? 730,
      currency: overrides.currency ?? 'GBP',
      status: 'succeeded',
      occurred_at: '2026-10-27T18:30:00Z',
      payment_method_code: null,
      external_reference: null,
    }],
    credit_notes: [],
  };
}

describe('per-session checkout', () => {
  it('shows £730 due before the session invoice payment', () => {
    expect(calculateSessionCheckout(sessionId, 'GBP', 980, [payment()], [])
      .due).toBe(730);
  });
  it('shows zero after £250 deposit and paid £730 session invoice even if stored payment status is stale', () => {
    const result = calculateSessionCheckout(sessionId, 'GBP', 980, [payment()], [invoice()]);
    expect(result.due).toBe(0);
    expect(result.depositPaid).toBe(250);
    expect(result.invoicedPaid).toBe(730);
  });
  it('never subtracts the same paid deposit twice when it is also linked to an invoice', () => {
    const result = calculateSessionCheckout(sessionId, 'GBP', 980, [payment()], [
      invoice({ paymentRequestId: 'deposit-one' }),
    ]);
    expect(result.depositPaid).toBe(0);
    expect(result.due).toBe(250);
  });
  it('rejects unsaved session price rather than making the hourly suggestion final', () => {
    expect(calculateSessionCheckout(sessionId, 'GBP', null, [payment()], []).due).toBeNull();
  });
  it('does not apply an unallocated project deposit to every session', () => {
    const result = calculateSessionCheckout(sessionId, 'GBP', 980, [payment({ session_id: null })], []);
    expect(result.warnings).toContain('unallocated_deposit');
    expect(result.due).toBeNull();
  });
  it('refuses mixed or unlinked invoices', () => {
    expect(calculateSessionCheckout(sessionId, 'GBP', 980, [], [
      invoice({ sessionIds: [sessionId, 'session-two'] }),
    ]).warnings).toContain('mixed_invoice');
    expect(calculateSessionCheckout(sessionId, 'GBP', 980, [], [
      invoice({ sessionIds: [null] }),
    ]).warnings).toContain('unlinked_invoice');
  });
  it('refuses conflicting currency and overpayment', () => {
    expect(calculateSessionCheckout(sessionId, 'GBP', 980, [payment({ currency: 'USD' })], [])
      .warnings).toContain('currency_mismatch');
    expect(calculateSessionCheckout(sessionId, 'GBP', 700, [payment()], [invoice()])
      .warnings).toContain('overpaid');
  });
  it('enables a payment only for an issued same-session invoice with exactly matching outstanding', () => {
    const base = invoice({ status: 'partially_paid', amountPaid: 300, remaining: 430 });
    expect(calculateSessionCheckout(sessionId, 'GBP', 980, [payment()], [base])
      .payableInvoice?.invoice.id).toBe('invoice-one');
    const mismatch = invoice({ status: 'issued', amountPaid: 300, remaining: 200 });
    expect(calculateSessionCheckout(sessionId, 'GBP', 980, [payment()], [mismatch])
      .payableInvoice).toBeNull();
  });
});
