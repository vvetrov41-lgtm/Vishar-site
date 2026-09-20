// The invoice screen.
//
// What is asserted here is the interface: which figures it shows, which RPC it
// calls with what, what it refuses before asking the server, and who is offered
// the controls at all. The arithmetic and the refusals themselves belong to the
// database and are pinned by pgTAP 293 - a fake that reimplemented them would
// let a wrong screen pass against a wrong server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  INVOICE_ID,
  MANAGER_ID,
  PROJECT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const NOW = new Date('2026-09-10T08:00:00Z');
const INVOICE_PATH = `/invoices/${INVOICE_ID}`;

/** Simon: seven hours at GBP140, a GBP250 deposit already taken. */
function document(overrides: Record<string, unknown> = {}) {
  const invoice = {
    id: INVOICE_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    client_id: CLIENT_ID,
    project_id: PROJECT_ID,
    invoice_number: 'INV-2026-00001',
    status: 'partially_paid',
    currency: 'GBP',
    issue_date: '2026-09-01',
    due_date: '2026-09-15',
    notes: null,
    void_reason: null,
    created_at: '2026-09-01T09:00:00Z',
    updated_at: '2026-09-01T09:00:00Z',
    subtotal: 980,
    discount_amount: 0,
    total: 980,
    amount_paid: 250,
    amount_credited: 0,
    amount_outstanding: 730,
    is_overdue: false,
    ...(overrides.invoice as Record<string, unknown> ?? {}),
  };
  return {
    invoice,
    artist: {
      id: VLADIMIR_ARTIST_ID,
      display_name: 'Vladimir Vishar',
      legal_name: 'Vishar Tattoo',
      timezone: 'Europe/London',
    },
    client: { id: CLIENT_ID, full_name: 'Simon Invoice', email: 'simon@example.test', phone: null },
    project: { id: PROJECT_ID, title: 'Simon sleeve' },
    line_items: overrides.line_items ?? [{
      id: 'li-1',
      session_id: null,
      line_position: 1,
      description: 'Tattoo session',
      quantity: 7,
      unit_amount: 140,
      line_total: 980,
    }],
    payments: overrides.payments ?? [{
      payment_request_id: 'pr-1',
      payment_transaction_id: 'pt-1',
      purpose: 'deposit',
      transaction_type: 'manual_payment',
      direction: 'credit',
      amount: 250,
      currency: 'GBP',
      status: 'succeeded',
      occurred_at: '2026-08-20T10:00:00Z',
      payment_method_code: 'bank_transfer',
      external_reference: 'MONZO-1',
    }],
    credit_notes: overrides.credit_notes ?? [],
  };
}

/** One figure from the summary list, read through its own label. */
function figure(label: string): string {
  const term = screen.getAllByText(label).find((node) => node.tagName === 'DT');
  return term?.parentElement?.querySelector('dd')?.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading an invoice', () => {
  it('shows total, paid and outstanding as the server derived them', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    // Two headings say the same thing in jsdom: the screen's and the printable
    // document's. In a browser the printable one is display:none and never
    // reaches the accessibility tree at all.
    expect(await screen.findAllByRole('heading', { level: 2, name: 'Invoice INV-2026-00001' }))
      .not.toHaveLength(0);
    expect(figure('Total')).toBe('£980.00');
    expect(figure('Paid')).toBe('£250.00');
    expect(figure('Credited')).toBe('£0.00');
    expect(figure('Outstanding')).toBe('£730.00');
    expect(screen.getAllByText('Part paid').length).toBeGreaterThan(0);
  });

  it('says overdue when the server says the due date has passed', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document({ invoice: { status: 'issued', is_overdue: true, amount_paid: 0, amount_outstanding: 980 } }),
    });

    expect(await screen.findByText('Overdue')).toBeInTheDocument();
  });

  it('carries the whole document into the printable version', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document({
        credit_notes: [{
          id: 'cn-1', credit_note_number: 'CN-2026-00001', amount: 140,
          reason: 'One hour shorter than quoted', issued_at: '2026-09-05T10:00:00Z',
        }],
      }),
    });

    const printable = await screen.findByRole('article', { name: 'Printable invoice' });
    expect(within(printable).getByText('Vishar Tattoo')).toBeInTheDocument();
    expect(within(printable).getByText(/Simon Invoice/)).toBeInTheDocument();
    expect(within(printable).getByText('Tattoo session')).toBeInTheDocument();
    expect(within(printable).getByText(/CN-2026-00001/)).toBeInTheDocument();
    expect(within(printable).getByText('All amounts in GBP.')).toBeInTheDocument();
  });

  it('keeps the line items of an issued invoice read-only', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    await screen.findByRole('heading', { level: 2, name: 'Line items' });
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
    expect(screen.getByText(/An issued invoice keeps the figures/)).toBeInTheDocument();
  });

  it('lets a draft be priced', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document({
        invoice: { status: 'draft', issue_date: null, amount_paid: 0, amount_outstanding: 980 },
        payments: [],
      }),
    });

    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Touch-up' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'set_invoice_line_item')).toBe(true);
    });
    expect(rpcCalls.find((call) => call.name === 'set_invoice_line_item')?.args).toMatchObject({
      p_invoice_id: INVOICE_ID,
      p_description: 'Touch-up',
      p_quantity: 2,
      p_unit_amount: 90,
    });
  });

  it('lets a draft carry a due date, a discount and a note', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document({
        invoice: { status: 'draft', issue_date: null, due_date: null, amount_paid: 0, amount_outstanding: 980 },
        payments: [],
      }),
    });

    const form = await screen.findByRole('form', { name: 'Invoice details' });
    fireEvent.change(within(form).getByLabelText('Due date'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(form).getByLabelText('Discount in GBP'), { target: { value: '40' } });
    fireEvent.change(within(form).getByLabelText('Notes'), { target: { value: 'Agreed on the day' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'set_invoice_details')).toBe(true);
    });
    expect(rpcCalls.find((call) => call.name === 'set_invoice_details')?.args).toMatchObject({
      p_invoice_id: INVOICE_ID,
      p_due_date: '2026-10-01',
      p_discount_amount: 40,
      p_notes: 'Agreed on the day',
    });
  });

  it('stops offering those fields once the invoice is issued', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    await screen.findByRole('heading', { level: 2, name: 'Line items' });
    expect(screen.queryByRole('form', { name: 'Invoice details' })).not.toBeInTheDocument();
  });
});

describe('recording money against an invoice', () => {
  it('sends the amount and the reference the operator entered', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    const form = await screen.findByRole('form', { name: 'Record payment' });
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '730' } });
    fireEvent.change(within(form).getByLabelText('Reference'), { target: { value: 'MONZO-2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record payment' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'record_invoice_payment')).toBe(true);
    });
    const call = rpcCalls.find((entry) => entry.name === 'record_invoice_payment');
    expect(call?.args).toMatchObject({
      p_invoice_id: INVOICE_ID,
      p_amount: 730,
      p_method_code: 'bank_transfer',
      p_external_reference: 'MONZO-2',
    });
    expect(typeof (call?.args as any)?.p_idempotency_key).toBe('string');
  });

  it('refuses more than the invoice still asks for without troubling the server', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    const form = await screen.findByRole('form', { name: 'Record payment' });
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '900' } });

    expect(within(form).getByRole('button', { name: 'Record payment' })).toBeDisabled();
    expect(within(form).getByText(/between zero and the outstanding balance/)).toBeInTheDocument();
    expect(rpcCalls.some((call) => call.name === 'record_invoice_payment')).toBe(false);
  });

  it('refuses a negative payment', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    const form = await screen.findByRole('form', { name: 'Record payment' });
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '-20' } });
    expect(within(form).getByRole('button', { name: 'Record payment' })).toBeDisabled();
  });

  it('cannot be pressed twice into two payments', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    const form = await screen.findByRole('form', { name: 'Record payment' });
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '100' } });
    const button = within(form).getByRole('button', { name: 'Record payment' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(rpcCalls.filter((call) => call.name === 'record_invoice_payment')).toHaveLength(1);
    });
  });

  it('offers a deposit already taken rather than asking for it again', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    const form = await screen.findByRole('form', { name: 'Count a deposit already taken' });
    const select = within(form).getByRole('combobox');
    const option = within(select).getAllByRole('option')[1] as HTMLOptionElement;
    fireEvent.change(select, { target: { value: option.value } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add to this invoice' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'attach_payment_request_to_invoice')).toBe(true);
    });
  });
});

describe('correcting an invoice', () => {
  it('asks before issuing a credit note, then sends the amount and the reason', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    const form = await screen.findByRole('form', { name: 'Issue credit note' });
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '140' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'One hour shorter' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Issue credit note' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Issue it' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'create_credit_note')).toBe(true);
    });
    expect(rpcCalls.find((call) => call.name === 'create_credit_note')?.args).toMatchObject({
      p_invoice_id: INVOICE_ID,
      p_amount: 140,
      p_reason: 'One hour shorter',
    });
  });

  it('refuses a credit note larger than the invoice still asks for', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document(),
    });

    const form = await screen.findByRole('form', { name: 'Issue credit note' });
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '5000' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Too much' } });

    expect(within(form).getByRole('button', { name: 'Issue credit note' })).toBeDisabled();
    expect(within(form).getByText(/cannot be more than the invoice still asks for/)).toBeInTheDocument();
    expect(rpcCalls.some((call) => call.name === 'create_credit_note')).toBe(false);
  });

  it('asks before voiding, and sends the reason', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document({ invoice: { status: 'issued', amount_paid: 0, amount_outstanding: 980 }, payments: [] }),
    });

    const form = await screen.findByRole('form', { name: 'Void invoice' });
    fireEvent.change(within(form).getByLabelText(/Why is this invoice/), {
      target: { value: 'Raised against the wrong project' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Void invoice' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Void it' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'void_invoice')).toBe(true);
    });
    expect(rpcCalls.find((call) => call.name === 'void_invoice')?.args).toMatchObject({
      p_reason: 'Raised against the wrong project',
    });
  });

  it('offers nothing at all on a void invoice', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: INVOICE_PATH,
      invoiceDocument: document({
        invoice: {
          status: 'void', void_reason: 'Raised in error',
          amount_paid: 0, amount_outstanding: 980,
        },
        payments: [],
      }),
    });

    expect(await screen.findByText(/Voided: Raised in error/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Record payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Issue credit note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Void invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
  });
});

describe('who may see and change an invoice', () => {
  it('shows the figures to a membership that may view finance but change nothing', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: INVOICE_PATH,
      invoiceDocument: document(),
      membershipOverrides: [{
        profile_id: MANAGER_ID,
        artist_id: VLADIMIR_ARTIST_ID,
        access_level: 'manager',
        can_view_finance: true,
        can_manage_finance: false,
        can_manage_sessions: true,
        can_manage_integrations: false,
        is_active: true,
      }],
    });

    expect(await screen.findAllByRole('heading', { level: 2, name: 'Invoice INV-2026-00001' }))
      .not.toHaveLength(0);
    expect(screen.queryByRole('form', { name: 'Record payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Issue credit note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Void invoice' })).not.toBeInTheDocument();
  });

  it('shows a manager with no finance membership the door', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: INVOICE_PATH,
      invoiceDocument: document(),
      membershipOverrides: [{
        profile_id: MANAGER_ID,
        artist_id: VLADIMIR_ARTIST_ID,
        access_level: 'manager',
        can_view_finance: false,
        can_manage_finance: false,
        can_manage_sessions: true,
        can_manage_integrations: false,
        is_active: true,
      }],
    });

    expect(await screen.findByRole('heading', { name: 'Not available for your role' }))
      .toBeInTheDocument();
    expect(screen.queryByText('INV-2026-00001')).not.toBeInTheDocument();
  });
});

describe('the invoice list', () => {
  const ROW = {
    id: INVOICE_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    client_id: CLIENT_ID,
    project_id: PROJECT_ID,
    invoice_number: 'INV-2026-00001',
    status: 'partially_paid',
    currency: 'GBP',
    issue_date: '2026-09-01',
    due_date: '2026-09-15',
    created_at: '2026-09-01T09:00:00Z',
    subtotal: 980,
    discount_amount: 0,
    total: 980,
    amount_paid: 250,
    amount_credited: 0,
    amount_outstanding: 730,
    is_overdue: false,
  };

  it('lists invoices with what each still asks for', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/invoices', invoices: [ROW] });

    expect(await screen.findByRole('link', { name: 'INV-2026-00001' })).toBeInTheDocument();
    expect(screen.getByText('Outstanding across these invoices: £730.00')).toBeInTheDocument();
  });

  it('asks the server for one status rather than filtering in the browser', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner', path: '/invoices', invoices: [ROW],
    });

    await screen.findByRole('link', { name: 'INV-2026-00001' });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'paid' } });

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'list_invoices' && (call.args as any)?.p_status === 'paid'))
        .toBe(true);
    });
  });

  it('shows a membership without finance access no invoices at all', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/invoices',
      invoices: [ROW],
      membershipOverrides: [{
        profile_id: MANAGER_ID,
        artist_id: VLADIMIR_ARTIST_ID,
        access_level: 'manager',
        can_view_finance: false,
        can_manage_finance: false,
        can_manage_sessions: true,
        can_manage_integrations: false,
        is_active: true,
      }],
    });

    expect(await screen.findByRole('heading', { name: 'Not available for your role' }))
      .toBeInTheDocument();
  });
});

describe('invoices on the project screen', () => {
  it('lists them and offers a new one to someone who may manage finance', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: `/projects/${PROJECT_ID}`,
      invoices: [{
        id: INVOICE_ID,
        artist_id: VLADIMIR_ARTIST_ID,
        client_id: CLIENT_ID,
        project_id: PROJECT_ID,
        invoice_number: 'INV-2026-00001',
        status: 'draft',
        currency: 'GBP',
        issue_date: null,
        due_date: null,
        created_at: '2026-09-01T09:00:00Z',
        subtotal: 980,
        discount_amount: 0,
        total: 980,
        amount_paid: 0,
        amount_credited: 0,
        amount_outstanding: 980,
        is_overdue: false,
      }],
    });

    const section = (await screen.findByRole('heading', { level: 2, name: 'Invoices' }))
      .closest('section') as HTMLElement;
    expect(within(section).getByRole('link', { name: 'INV-2026-00001' })).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'New invoice' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'create_invoice')).toBe(true);
    });
    expect(rpcCalls.find((call) => call.name === 'create_invoice')?.args)
      .toMatchObject({ p_project_id: PROJECT_ID });
  });
});
