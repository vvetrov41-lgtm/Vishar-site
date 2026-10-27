import type { InvoiceDocument } from './invoice-api';
import type { ProjectPaymentRequest } from './payment-api';

export type CheckoutWarning =
  | 'unallocated_deposit'
  | 'unlinked_invoice'
  | 'mixed_invoice'
  | 'currency_mismatch'
  | 'overpaid'
  | 'credited_invoice'
  | 'incomplete_history';

export interface SessionCheckoutBalance {
  price: number | null;
  depositPaid: number;
  invoicedPaid: number;
  due: number | null;
  warnings: CheckoutWarning[];
  sessionInvoices: InvoiceDocument[];
  /** Only eligible when the invoice's outstanding amount matches the session's due. */
  payableInvoice: InvoiceDocument | null;
}

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Conservative checkout math. Every credit must be explicitly attributable to
 * this session. A project-level paid deposit or multi-session invoice cannot
 * be automatically assigned without a server-side allocation record.
 *
 * Never use `sessions.payment_status` to compute money: it can lag the ledger.
 */
export function calculateSessionCheckout(
  sessionId: string,
  currency: string,
  storedPrice: number | null,
  requests: ProjectPaymentRequest[],
  invoices: InvoiceDocument[]
): SessionCheckoutBalance {
  const warnings = new Set<CheckoutWarning>();
  const currencyMatches = (rowCurrency: string) => rowCurrency === currency;
  const activeInvoices = invoices.filter((document) => document.invoice.status !== 'void');
  const sessionInvoices = activeInvoices.filter((document) =>
    document.line_items.some((item) => item.session_id === sessionId)
  );

  for (const request of requests) {
    if (request.net_paid <= 0 || request.purpose !== 'deposit') continue;
    if (!currencyMatches(request.currency) && (request.session_id === sessionId || request.session_id == null)) {
      warnings.add('currency_mismatch');
    }
    if (request.session_id == null) warnings.add('unallocated_deposit');
  }

  for (const document of activeInvoices) {
    if (document.line_items.length === 0 || document.line_items.some((item) => item.session_id == null)) {
      // The invoice may be for this session. Do not create an extra invoice.
      warnings.add('unlinked_invoice');
    }
    if (!sessionInvoices.includes(document)) continue;
    if (!currencyMatches(document.invoice.currency)) warnings.add('currency_mismatch');
    if (document.invoice.amount_credited > 0 || document.invoice.discount_amount > 0) {
      warnings.add('credited_invoice');
    }
    if (document.line_items.some((item) => item.session_id !== sessionId)) warnings.add('mixed_invoice');
  }

  const invoicePaymentRequestIds = new Set(
    sessionInvoices.flatMap((document) => document.payments
      .filter((payment) => payment.status === 'succeeded')
      .map((payment) => payment.payment_request_id))
  );

  const depositPaid = round(requests
    .filter((request) => request.session_id === sessionId
      && request.purpose === 'deposit'
      && currencyMatches(request.currency)
      && !invoicePaymentRequestIds.has(request.id))
    .reduce((sum, request) => sum + request.net_paid, 0));

  const attributableInvoices = sessionInvoices.filter((document) =>
    currencyMatches(document.invoice.currency)
    && document.line_items.length > 0
    && document.line_items.every((line) => line.session_id === sessionId)
  );
  const invoicedPaid = round(attributableInvoices
    .reduce((sum, document) => sum + document.invoice.amount_paid, 0));

  if (storedPrice != null && storedPrice + 0.005 < depositPaid + invoicedPaid) {
    warnings.add('overpaid');
  }
  const warningList = [...warnings];
  const safe = warningList.length === 0
    && storedPrice != null
    && Number.isFinite(storedPrice)
    && storedPrice >= 0;

  const due = safe ? round(Math.max(0, storedPrice - depositPaid - invoicedPaid)) : null;
  const payableInvoice = due != null && due > 0
    && sessionInvoices.length === 1
    && ['issued', 'partially_paid'].includes(sessionInvoices[0].invoice.status)
    && Math.abs(sessionInvoices[0].invoice.amount_outstanding - due) < 0.005
      ? sessionInvoices[0] : null;

  return {
    price: storedPrice,
    depositPaid,
    invoicedPaid,
    due,
    warnings: warningList,
    sessionInvoices,
    payableInvoice,
  };
}
