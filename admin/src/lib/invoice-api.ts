// Invoices, line items, payments and credit notes.
//
// Every write here is one named RPC and sends ids, never money the browser
// worked out. The server recomputes the subtotal from the line items it holds,
// caps a payment at the outstanding balance and caps a credit note at the
// unsettled remainder, so an edited request body changes nothing but which
// record is named.
//
// Reads come back from `get_invoice` and `list_invoices`, which apply the same
// finance visibility the invoice tables' own policies apply.

import { ApiError, friendlyMessage, type ApiOperation, type CrmClient } from './api';

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void';

export interface InvoiceSummary {
  id: string;
  artist_id: string;
  client_id: string;
  project_id: string;
  invoice_number: string;
  status: InvoiceStatus;
  currency: string;
  issue_date: string | null;
  due_date: string | null;
  created_at: string;
  subtotal: number;
  discount_amount: number;
  total: number;
  amount_paid: number;
  amount_credited: number;
  amount_outstanding: number;
  is_overdue: boolean;
}

export interface InvoiceLineItem {
  id: string;
  session_id: string | null;
  line_position: number;
  description: string;
  quantity: number;
  unit_amount: number;
  line_total: number;
}

export interface InvoicePayment {
  payment_request_id: string;
  payment_transaction_id: string;
  purpose: string;
  transaction_type: string;
  direction: 'credit' | 'debit';
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed';
  occurred_at: string;
  payment_method_code: string | null;
  external_reference: string | null;
}

export interface InvoiceCreditNote {
  id: string;
  credit_note_number: string;
  amount: number;
  reason: string;
  issued_at: string;
}

export interface InvoiceDocument {
  invoice: InvoiceSummary & { notes: string | null; void_reason: string | null; updated_at: string };
  artist: { id: string; display_name: string; legal_name: string | null; timezone: string };
  client: { id: string; full_name: string; email: string | null; phone: string | null };
  project: { id: string; title: string };
  line_items: InvoiceLineItem[];
  payments: InvoicePayment[];
  credit_notes: InvoiceCreditNote[];
}

function unwrap<T>(result: { data: T | null; error: any }, what: ApiOperation): T {
  if (result.error) throw new ApiError(friendlyMessage(result.error, what), result.error);
  return result.data as T;
}

/** Numeric columns arrive as strings from PostgREST when they are `numeric`. */
function money(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normaliseSummary(row: any): InvoiceSummary {
  return {
    id: String(row.id),
    artist_id: String(row.artist_id),
    client_id: String(row.client_id),
    project_id: String(row.project_id),
    invoice_number: String(row.invoice_number),
    status: row.status as InvoiceStatus,
    currency: String(row.currency ?? 'GBP'),
    issue_date: row.issue_date ?? null,
    due_date: row.due_date ?? null,
    created_at: String(row.created_at ?? ''),
    subtotal: money(row.subtotal),
    discount_amount: money(row.discount_amount),
    total: money(row.total),
    amount_paid: money(row.amount_paid),
    amount_credited: money(row.amount_credited),
    amount_outstanding: money(row.amount_outstanding),
    is_overdue: row.is_overdue === true,
  };
}

function normaliseDocument(payload: any): InvoiceDocument {
  const invoice = payload?.invoice ?? {};
  return {
    invoice: {
      ...normaliseSummary(invoice),
      notes: invoice.notes ?? null,
      void_reason: invoice.void_reason ?? null,
      updated_at: String(invoice.updated_at ?? ''),
    },
    artist: {
      id: String(payload?.artist?.id ?? ''),
      display_name: String(payload?.artist?.display_name ?? ''),
      legal_name: payload?.artist?.legal_name ?? null,
      timezone: String(payload?.artist?.timezone ?? 'Europe/London'),
    },
    client: {
      id: String(payload?.client?.id ?? ''),
      full_name: String(payload?.client?.full_name ?? ''),
      email: payload?.client?.email ?? null,
      phone: payload?.client?.phone ?? null,
    },
    project: {
      id: String(payload?.project?.id ?? ''),
      title: String(payload?.project?.title ?? ''),
    },
    line_items: (payload?.line_items ?? []).map((row: any) => ({
      id: String(row.id),
      session_id: row.session_id ?? null,
      line_position: Number(row.line_position ?? 1),
      description: String(row.description ?? ''),
      quantity: money(row.quantity),
      unit_amount: money(row.unit_amount),
      line_total: money(row.line_total),
    })),
    payments: (payload?.payments ?? []).map((row: any) => ({
      payment_request_id: String(row.payment_request_id),
      payment_transaction_id: String(row.payment_transaction_id),
      purpose: String(row.purpose ?? 'other'),
      transaction_type: String(row.transaction_type ?? 'manual_payment'),
      direction: row.direction === 'debit' ? 'debit' : 'credit',
      amount: money(row.amount),
      currency: String(row.currency ?? 'GBP'),
      status: row.status === 'failed' ? 'failed' : 'succeeded',
      occurred_at: String(row.occurred_at ?? ''),
      payment_method_code: row.payment_method_code ?? null,
      external_reference: row.external_reference ?? null,
    })),
    credit_notes: (payload?.credit_notes ?? []).map((row: any) => ({
      id: String(row.id),
      credit_note_number: String(row.credit_note_number),
      amount: money(row.amount),
      reason: String(row.reason ?? ''),
      issued_at: String(row.issued_at ?? ''),
    })),
  };
}

export function createInvoiceApi(client: CrmClient) {
  return {
    async listInvoices(filters: {
      artistId?: string | null;
      projectId?: string | null;
      clientId?: string | null;
      status?: InvoiceStatus | null;
      limit?: number;
    } = {}): Promise<InvoiceSummary[]> {
      const rows = unwrap<any[]>(
        await client.rpc('list_invoices', {
          p_artist_id: filters.artistId ?? null,
          p_project_id: filters.projectId ?? null,
          p_client_id: filters.clientId ?? null,
          p_status: filters.status ?? null,
          p_limit: filters.limit ?? 100,
        }),
        'load invoices'
      );
      return (rows ?? []).map(normaliseSummary);
    },

    async getInvoice(invoiceId: string): Promise<InvoiceDocument> {
      return normaliseDocument(unwrap<any>(
        await client.rpc('get_invoice', { p_invoice_id: invoiceId }),
        'load that invoice'
      ));
    },

    async createInvoice(input: {
      projectId: string;
      dueDate?: string | null;
      notes?: string | null;
      idempotencyKey?: string;
    }): Promise<{ invoice_id: string; invoice_number: string; replayed: boolean }> {
      return unwrap<any>(
        await client.rpc('create_invoice', {
          p_project_id: input.projectId,
          p_idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
          p_due_date: input.dueDate ?? null,
          p_notes: input.notes ?? null,
        }),
        'create that invoice'
      );
    },

    /** Adds a line, or replaces one when `lineItemId` is given. */
    async setInvoiceLineItem(input: {
      invoiceId: string;
      description: string;
      quantity: number;
      unitAmount: number;
      lineItemId?: string | null;
      sessionId?: string | null;
      linePosition?: number | null;
    }): Promise<{ line_item_id: string }> {
      return unwrap<any>(
        await client.rpc('set_invoice_line_item', {
          p_invoice_id: input.invoiceId,
          p_description: input.description,
          p_quantity: input.quantity,
          p_unit_amount: input.unitAmount,
          p_line_item_id: input.lineItemId ?? null,
          p_session_id: input.sessionId ?? null,
          p_line_position: input.linePosition ?? null,
        }),
        'save that invoice line'
      );
    },

    async removeInvoiceLineItem(lineItemId: string): Promise<{ removed: boolean }> {
      return unwrap<any>(
        await client.rpc('remove_invoice_line_item', { p_line_item_id: lineItemId }),
        'remove that invoice line'
      );
    },

    async setInvoiceDetails(input: {
      invoiceId: string;
      dueDate?: string | null;
      discountAmount?: number | null;
      notes?: string | null;
    }): Promise<{ updated: boolean }> {
      return unwrap<any>(
        await client.rpc('set_invoice_details', {
          p_invoice_id: input.invoiceId,
          p_due_date: input.dueDate ?? null,
          p_discount_amount: input.discountAmount ?? null,
          p_notes: input.notes ?? null,
        }),
        'save those invoice details'
      );
    },

    async issueInvoice(invoiceId: string, issueDate?: string | null) {
      return unwrap<any>(
        await client.rpc('issue_invoice', {
          p_invoice_id: invoiceId,
          p_issue_date: issueDate ?? null,
        }),
        'issue that invoice'
      );
    },

    async voidInvoice(invoiceId: string, reason: string) {
      return unwrap<any>(
        await client.rpc('void_invoice', { p_invoice_id: invoiceId, p_reason: reason }),
        'void that invoice'
      );
    },

    async attachPaymentRequestToInvoice(input: { paymentRequestId: string; invoiceId: string }) {
      return unwrap<any>(
        await client.rpc('attach_payment_request_to_invoice', {
          p_payment_request_id: input.paymentRequestId,
          p_invoice_id: input.invoiceId,
        }),
        'link that payment to the invoice'
      );
    },

    /**
     * The idempotency key is minted once per attempt by the caller, so a double
     * tap replays rather than charging twice. The server caps the amount at the
     * outstanding balance regardless.
     */
    async recordInvoicePayment(input: {
      invoiceId: string;
      amount: number;
      idempotencyKey: string;
      occurredAt?: string;
      methodCode?: string | null;
      externalReference?: string | null;
    }) {
      return unwrap<any>(
        await client.rpc('record_invoice_payment', {
          p_invoice_id: input.invoiceId,
          p_idempotency_key: input.idempotencyKey,
          p_amount: input.amount,
          p_occurred_at: input.occurredAt ?? new Date().toISOString(),
          p_method_code: input.methodCode ?? null,
          p_external_reference: input.externalReference ?? null,
        }),
        'record that invoice payment'
      );
    },

    async createCreditNote(input: {
      invoiceId: string;
      amount: number;
      reason: string;
      idempotencyKey: string;
    }) {
      return unwrap<any>(
        await client.rpc('create_credit_note', {
          p_invoice_id: input.invoiceId,
          p_idempotency_key: input.idempotencyKey,
          p_amount: input.amount,
          p_reason: input.reason,
        }),
        'create that credit note'
      );
    },
  };
}

export type InvoiceApi = ReturnType<typeof createInvoiceApi>;

export const INVOICE_STATUSES: InvoiceStatus[] = [
  'draft', 'issued', 'partially_paid', 'paid', 'void',
];

export function invoiceStatusLabel(
  status: InvoiceStatus,
  overdue: boolean,
  language: 'en' | 'ru'
): string {
  if (overdue && (status === 'issued' || status === 'partially_paid')) {
    return language === 'ru' ? 'Просрочен' : 'Overdue';
  }
  const labels = {
    en: {
      draft: 'Draft',
      issued: 'Issued',
      partially_paid: 'Part paid',
      paid: 'Paid',
      void: 'Void',
    },
    ru: {
      draft: 'Черновик',
      issued: 'Выставлен',
      partially_paid: 'Оплачен частично',
      paid: 'Оплачен',
      void: 'Аннулирован',
    },
  } as const;
  return labels[language][status];
}
