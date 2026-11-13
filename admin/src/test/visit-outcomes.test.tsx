import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('../lib/confirm-dialog', () => ({
  confirmDialog: vi.fn(async () => true),
  cancelLabelFor: () => 'Cancel',
}));

import { App } from '../App';
import { CLIENT_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';
import { clearTodayCache } from '../lib/today-resource';
import { OperationKeys, deferUntil, parseHoursInput, parseMoneyInput, previewPayment } from '../lib/visit-outcome';
import { classifyVisitOutcomeError, type VisitFinance } from '../lib/visit-outcome-api';

const SESSION_ID = '0d000000-0000-4000-8000-000000000001';
const CONSULTATION_ID = '0d000000-0000-4000-8000-000000000002';
const BOOKING_ID = '0d000000-0000-4000-8000-000000000003';

function finance(overrides: Partial<VisitFinance> = {}): VisitFinance {
  return {
    currency: 'GBP', price: null, stored_price: null, deposit_paid: 250, invoiced_paid: 0,
    due: null, warnings: [], session_invoice_count: 0, payable_invoice_id: null,
    hourly_rate: 140, project_currency: 'GBP', ...overrides,
  };
}

function tattooContext(version = 0) {
  return {
    session: {
      id: SESSION_ID, artist_id: VLADIMIR_ARTIST_ID, client_id: CLIENT_ID, client_name: 'Visit Client',
      appointment_type: 'tattoo_session', status: 'completed',
      start_at: '2026-09-01T09:00:00Z', end_at: '2026-09-01T16:00:00Z', scheduled_minutes: 420,
      project_id: 'p1', enquiry_id: null, enquiry_status: null, currency: 'GBP', payment_status: 'deposit_paid',
    },
    outcome: null, version, finance: finance(), bookings: null, aftercare_sent: true,
    can: { record: true, finance: true, follow_up: true, view_finance: true },
    needs_review: true, server_time: '2026-09-01T17:00:00Z',
  };
}

function consultationContext() {
  return {
    session: {
      id: CONSULTATION_ID, artist_id: VLADIMIR_ARTIST_ID, client_id: CLIENT_ID, client_name: 'Consult Client',
      appointment_type: 'in_person_consultation', status: 'confirmed',
      start_at: '2026-09-01T10:00:00Z', end_at: '2026-09-01T10:30:00Z', scheduled_minutes: 30,
      project_id: null, enquiry_id: null, enquiry_status: null, currency: 'GBP',
    },
    outcome: null, version: 0, finance: null,
    bookings: [{ id: BOOKING_ID, appointment_type: 'tattoo_session', status: 'confirmed',
      start_at: '2026-09-20T10:00:00Z', end_at: '2026-09-20T16:00:00Z', project_id: 'p2' }],
    aftercare_sent: null,
    can: { record: true, finance: true, follow_up: true, view_finance: true },
    needs_review: true, server_time: '2026-09-01T17:00:00Z',
  };
}

function pulseWith(items: Array<{ id: string; type: string }>) {
  return {
    enabled: true, generated_at: '2026-09-01T17:00:00Z', artists: [],
    items: items.map(({ id, type }) => ({
      key: `visit-outcome-${id}`, kind: 'visit_outcome', section: 'visit_outcomes', reason: 'visit_outcome_auto_completed',
      artist_id: VLADIMIR_ARTIST_ID, client_id: CLIENT_ID, subject: 'Visit Client', href: `/appointments/${id}`,
      at: '2026-09-01T16:00:00Z', detail: type, acknowledgement: null, urgent: false,
    })),
  };
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-09-01T17:00:00Z') });
});
afterEach(() => { clearTodayCache(); vi.useRealTimers(); });

describe('visit outcome arithmetic', () => {
  it('splits price, earlier deposit, money received now and balance', () => {
    const preview = previewPayment(finance(), 980, 730, false);
    expect(preview.alreadyRecorded).toBe(250);
    expect(preview.dueBefore).toBe(730);
    expect(preview.dueAfter).toBe(0);
    expect(preview.totalPaid).toBe(980);
    expect(preview.state).toBe('paid');
    expect(preview.overBalance).toBe(false);
  });

  it('never lets the deposit be taken again as new money', () => {
    expect(previewPayment(finance(), 980, 980, false).overBalance).toBe(true);
  });

  it('keeps a partial payment and its balance', () => {
    const preview = previewPayment(finance({ deposit_paid: 0 }), 980, 500, false);
    expect(preview.state).toBe('part_paid');
    expect(preview.dueAfter).toBe(480);
  });

  it('refuses to compute money when the ledger needs review', () => {
    expect(previewPayment(finance({ warnings: ['unallocated_deposit'] }), 980, 0, false).state).toBe('needs_review');
  });

  it('treats a balance received outside the CRM as paid without new income', () => {
    const preview = previewPayment(finance({ deposit_paid: 0 }), 500, 0, true);
    expect(preview.state).toBe('paid');
    expect(preview.dueAfter).toBe(0);
  });

  it('parses phone input and reuses one operation id per request', () => {
    expect(parseMoneyInput('730,50')).toBe(730.5);
    expect(parseMoneyInput('0', { allowZero: true })).toBe(0);
    expect(parseMoneyInput('-5')).toBeNull();
    expect(parseHoursInput('4.5')).toBe(270);
    expect(parseHoursInput('25')).toBeNull();
    let n = 0;
    const keys = new OperationKeys(() => `op-${++n}`);
    expect(keys.keyFor({ a: 1 })).toBe('op-1');
    expect(keys.keyFor({ a: 1 })).toBe('op-1');
    expect(keys.keyFor({ a: 2 })).toBe('op-2');
    keys.reset();
    expect(keys.keyFor({ a: 2 })).toBe('op-3');
  });

  it('postpones to the next morning', () => {
    const until = deferUntil(new Date(2026, 8, 1, 17, 0));
    expect(until.getDate()).toBe(2);
    expect(until.getHours()).toBe(10);
  });

  it('names database refusals', () => {
    expect(classifyVisitOutcomeError({ code: '40001', message: 'this visit outcome was changed in another session; reload and try again' })).toBe('stale');
    expect(classifyVisitOutcomeError({ code: '23514', message: 'the amount received is more than the remaining balance (730)' })).toBe('over_balance');
    expect(classifyVisitOutcomeError({ code: '42501', message: 'artist access is not permitted' })).toBe('permission');
    expect(classifyVisitOutcomeError({ code: 'PGRST202', message: 'not found' })).toBe('unavailable');
  });
});

describe('Today visit outcomes', () => {
  it('records a held session with the deposit counted once', async () => {
    const recorded: Array<Record<string, unknown> | undefined> = [];
    let release!: () => void;
    const slow = new Promise<void>((done) => { release = done; });
    renderWithSession(<App />, {
      role: 'owner', path: '/', todayPulse: pulseWith([{ id: SESSION_ID, type: 'tattoo_session' }]),
      rpcHandlers: {
        get_visit_outcome_context: () => ({ data: tattooContext(), error: null }),
        record_visit_outcome: async (args) => {
          recorded.push(args);
          await slow;
          return { data: { session_id: SESSION_ID, outcome: 'attended', state: 'confirmed', version: 1, correction: false,
            session_status: 'completed', payment_state: 'paid', aftercare_already_sent: true, replayed: false }, error: null };
        },
      },
    });

    expect(await screen.findByRole('heading', { name: /Visit outcomes/ })).toBeVisible();
    const card = (await screen.findByText('How did the session go?')).closest('.visit-outcome') as HTMLElement;
    expect(within(card).getByText(/Deposit: £250/)).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: 'Session happened' }));

    const hours = within(card).getByLabelText(/Actual working time/);
    expect(hours).toHaveValue('7');
    expect(within(card).getByText(/Not confirmed/)).toBeVisible();
    fireEvent.change(hours, { target: { value: '6.5' } });
    fireEvent.change(within(card).getByLabelText(/Final price, GBP/), { target: { value: '980' } });
    const receivedInput = await within(card).findByLabelText(/Received now, GBP/);
    await waitFor(() => expect(receivedInput).toHaveValue('730'));
    fireEvent.click(within(card).getByRole('button', { name: 'Cash' }));
    expect(within(card).getByText(/Paid in total £980.*new money now £730.*balance £0/)).toBeVisible();

    const save = within(card).getByRole('button', { name: 'Save outcome' });
    fireEvent.click(save);
    await waitFor(() => expect(recorded).toHaveLength(1));
    // A second tap while saving is ignored.
    expect(within(card).getByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.click(within(card).getByRole('button', { name: 'Saving…' }));
    await act(async () => { release(); });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      p_session_id: SESSION_ID,
      p_expected_version: 0,
      p_outcome: 'attended',
      p_details: { worked_minutes: 390, final_price: 980, received_now: 730, payment_method: 'cash', work_result: 'work_complete' },
    });
    expect(typeof recorded[0]?.p_operation_id).toBe('string');
    expect((await screen.findAllByText(/Outcome saved/)).length).toBeGreaterThan(0);
  });

  it('retries a failed save with the same operation id', async () => {
    const recorded: Array<Record<string, unknown> | undefined> = [];
    renderWithSession(<App />, {
      role: 'owner', path: '/', todayPulse: pulseWith([{ id: SESSION_ID, type: 'tattoo_session' }]),
      rpcHandlers: {
        get_visit_outcome_context: () => ({ data: tattooContext(), error: null }),
        record_visit_outcome: (args) => {
          recorded.push(args);
          return recorded.length === 1
            ? { data: null, error: { code: '08006', message: 'connection lost' } }
            : { data: { session_id: SESSION_ID, outcome: 'no_show', state: 'confirmed', version: 1, correction: false,
              session_status: 'no_show', payment_state: null, aftercare_already_sent: false, replayed: true }, error: null };
        },
      },
    });
    const card = (await screen.findByText('How did the session go?')).closest('.visit-outcome') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Client did not come' }));
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(await within(card).findByRole('alert')).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: 'Client did not come' }));
    await waitFor(() => expect(recorded).toHaveLength(2));
    expect(recorded[1]?.p_operation_id).toBe(recorded[0]?.p_operation_id);
  });

  it('refreshes after an edit from another session and asks again', async () => {
    let version = 0;
    renderWithSession(<App />, {
      role: 'owner', path: '/', todayPulse: pulseWith([{ id: SESSION_ID, type: 'tattoo_session' }]),
      rpcHandlers: {
        get_visit_outcome_context: () => ({ data: tattooContext(version), error: null }),
        record_visit_outcome: () => {
          version = 1;
          return { data: null, error: { code: '40001', message: 'this visit outcome was changed in another session; reload and try again' } };
        },
      },
    });
    const card = (await screen.findByText('How did the session go?')).closest('.visit-outcome') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Session cancelled' }));
    expect(await within(card).findByText(/changed in another tab or device/)).toBeVisible();
  });

  it('links a consultation to the existing booking, with no payment fields', async () => {
    const recorded: Array<Record<string, unknown> | undefined> = [];
    renderWithSession(<App />, {
      role: 'owner', path: '/', todayPulse: pulseWith([{ id: CONSULTATION_ID, type: 'in_person_consultation' }]),
      rpcHandlers: {
        get_visit_outcome_context: () => ({ data: consultationContext(), error: null }),
        record_visit_outcome: (args) => {
          recorded.push(args);
          return { data: { session_id: CONSULTATION_ID, outcome: 'booked', state: 'confirmed', version: 1, correction: false,
            session_status: 'completed', payment_state: null, aftercare_already_sent: false, replayed: false }, error: null };
        },
      },
    });
    const card = (await screen.findByText('How did the consultation go?')).closest('.visit-outcome') as HTMLElement;
    expect(within(card).queryByText(/Deposit/)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Booked a tattoo' }));
    expect(within(card).queryByLabelText(/Received now/)).not.toBeInTheDocument();
    expect(within(card).getByRole('radio', { checked: true })).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: 'Save outcome' }));
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({ p_outcome: 'booked', p_details: { linked_session_id: BOOKING_ID } });
    expect(Object.keys(recorded[0]?.p_details as object)).not.toContain('final_price');
  });

  it('keeps visit cards out of the urgent list', async () => {
    renderWithSession(<App />, {
      role: 'owner', path: '/', todayPulse: pulseWith([{ id: SESSION_ID, type: 'tattoo_session' }]),
      rpcHandlers: { get_visit_outcome_context: () => ({ data: tattooContext(), error: null }) },
    });
    await screen.findByText('How did the session go?');
    expect(screen.queryByText('Visit outcome to confirm')).not.toBeInTheDocument();
  });
});
