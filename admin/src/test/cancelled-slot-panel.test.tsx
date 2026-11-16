import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Appointment } from '../lib/appointment-api';
import { CancelledSlotPanel } from '../components/CancelledSlotPanel';
import { VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

const NOW = Date.parse('2026-11-16T10:00:00Z');
const SLOT_ID = '0e000000-0000-4000-8000-000000000001';

const CANCELLED: Appointment = {
  id: SLOT_ID,
  artist_id: VLADIMIR_ARTIST_ID,
  client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  enquiry_id: null,
  project_id: null,
  appointment_type: 'tattoo_session',
  status: 'cancelled',
  start_at: '2026-11-26T11:00:00Z',
  end_at: '2026-11-26T17:00:00Z',
  duration_hours: 6,
  currency: 'GBP',
  payment_status: 'unpaid',
  calendar_provider: 'none',
  calendar_event_id: null,
  calendar_version: 1,
  calendar_sync_status: 'not_connected',
  calendar_last_synced_version: null,
  calendar_last_synced_at: null,
  calendar_last_error_code: null,
  client_response: null,
  client_response_at: null,
  client_response_calendar_version: null,
  notes: null,
  cancelled_at: '2026-11-16T09:00:00Z',
};

const RESULT = {
  slot: {
    session_id: SLOT_ID, artist_id: VLADIMIR_ARTIST_ID, appointment_type: 'tattoo_session',
    start_at: CANCELLED.start_at, end_at: CANCELLED.end_at, duration_hours: '6.00',
    timezone: 'Europe/London', state: 'open',
  },
  candidates: [
    {
      client_id: 'd1000000-0000-4000-8000-000000000001', client_name: 'Dana Deposit',
      reason: 'deposit_paid_no_date', project_id: 'p1000000-0000-4000-8000-000000000001',
      enquiry_id: null, follow_up_id: null, needed_hours: '5.0', fit: 'fits',
      phone: '+447700900001', email: null, instagram: null, preferred_contact: 'whatsapp',
      draft_message: 'Hi Dana, a slot has just opened up on Wednesday 26 November from 11:00 to 17:00.',
    },
    {
      client_id: 'd1000000-0000-4000-8000-000000000002', client_name: 'Pat Project',
      reason: 'project_no_date', project_id: 'p1000000-0000-4000-8000-000000000002',
      enquiry_id: null, follow_up_id: null, needed_hours: 8, fit: 'longer',
      phone: null, email: 'pat@example.test', instagram: null, preferred_contact: null,
      draft_message: 'Hi Pat, a slot has just opened up.',
    },
  ],
};

describe('Fill a cancelled slot', () => {
  it('lists candidates with reason, fit, editable draft and a WhatsApp link, and sends nothing', async () => {
    const { rpcCalls } = renderWithSession(<CancelledSlotPanel appointment={CANCELLED} now={NOW} />, {
      role: 'owner',
      rpcHandlers: { list_cancelled_slot_candidates: () => ({ data: RESULT, error: null }) },
    });

    expect(rpcCalls.some((call) => call.name === 'list_cancelled_slot_candidates')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Who can take this slot?' }));

    const panel = await screen.findByRole('region', { name: 'Fill this slot' });
    expect(await within(panel).findByText('Dana Deposit')).toBeVisible();
    expect(within(panel).getByText('Deposit paid, no date')).toBeVisible();
    expect(within(panel).getByText('Fits: 5 h / 6 h')).toBeVisible();
    expect(within(panel).getByText('Longer than the slot: 8 h / 6 h')).toBeVisible();
    expect(within(panel).getByText(/Nothing is sent automatically/)).toBeVisible();

    const dana = panel.querySelector('[data-slot-candidate="d1000000-0000-4000-8000-000000000001"]') as HTMLElement;
    const draft = within(dana).getByLabelText('Draft message');
    fireEvent.change(draft, { target: { value: 'Hi Dana, free on Wednesday?' } });
    const link = within(dana).getByRole('link', { name: 'Open WhatsApp' });
    expect(link).toHaveAttribute('href', `https://wa.me/447700900001?text=${encodeURIComponent('Hi Dana, free on Wednesday?')}`);

    const pat = panel.querySelector('[data-slot-candidate="d1000000-0000-4000-8000-000000000002"]') as HTMLElement;
    expect(within(pat).queryByRole('link', { name: 'Open WhatsApp' })).toBeNull();
    expect(within(pat).getByText('No phone number')).toBeVisible();

    const calls = rpcCalls.map((call) => call.name);
    expect(calls.filter((name) => name === 'list_cancelled_slot_candidates')).toHaveLength(1);
    expect(rpcCalls.find((call) => call.name === 'list_cancelled_slot_candidates')?.args).toEqual({ p_session_id: SLOT_ID });
    expect(calls.some((name) => /send|queue|record|create|book/.test(name))).toBe(false);
  });

  it('explains a slot that has been taken', async () => {
    renderWithSession(<CancelledSlotPanel appointment={CANCELLED} now={NOW} />, {
      role: 'owner',
      rpcHandlers: {
        list_cancelled_slot_candidates: () => ({ data: { slot: { ...RESULT.slot, state: 'taken' }, candidates: [] }, error: null }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Who can take this slot?' }));
    expect(await screen.findByText('Another appointment already uses this time.')).toBeVisible();
  });

  it('is shown only for a cancelled appointment still ahead', async () => {
    renderWithSession(
      <>
        <CancelledSlotPanel appointment={CANCELLED} now={NOW} />
        <CancelledSlotPanel appointment={{ ...CANCELLED, id: 'past', start_at: '2026-11-10T11:00:00Z' }} now={NOW} />
        <CancelledSlotPanel appointment={{ ...CANCELLED, id: 'active', status: 'confirmed', cancelled_at: null }} now={NOW} />
      </>,
      { role: 'owner' },
    );
    expect(await screen.findByRole('button', { name: 'Who can take this slot?' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Who can take this slot?' })).toHaveLength(1);
  });
});
