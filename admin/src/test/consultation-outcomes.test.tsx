import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { consultationAwaitingOutcome } from '../lib/appointment-display-status';
import { CLIENT_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

const NOW = new Date('2026-09-10T12:00:00Z');

function consultation(id: string, status: string, startAt: string, minutes = 30) {
  const start = Date.parse(startAt);
  return {
    id,
    artist_id: VLADIMIR_ARTIST_ID,
    client_id: CLIENT_ID,
    enquiry_id: null,
    project_id: null,
    appointment_type: 'in_person_consultation',
    status,
    start_at: new Date(start).toISOString(),
    end_at: new Date(start + minutes * 60_000).toISOString(),
    duration_hours: minutes / 60,
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
    cancelled_at: null,
  };
}

describe('consultation outcome', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }); });
  afterEach(() => { vi.useRealTimers(); });

  it('treats only an ended, still confirmed consultation as awaiting its outcome', () => {
    const now = NOW.getTime();
    expect(consultationAwaitingOutcome(consultation('a', 'confirmed', '2026-09-08T10:00:00Z') as never, now)).toBe(true);
    expect(consultationAwaitingOutcome(consultation('b', 'confirmed', '2026-09-12T10:00:00Z') as never, now)).toBe(false);
    expect(consultationAwaitingOutcome(consultation('c', 'cancelled', '2026-09-08T10:00:00Z') as never, now)).toBe(false);
    expect(consultationAwaitingOutcome(consultation('d', 'completed', '2026-09-08T10:00:00Z') as never, now)).toBe(false);
    expect(consultationAwaitingOutcome({ ...consultation('e', 'confirmed', '2026-09-08T10:00:00Z'), appointment_type: 'tattoo_session' } as never, now)).toBe(false);
  });

  it('lists ended consultations and records "took place" or "did not come" through the status RPC', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
      rpcCalls,
      extraSessions: [
        consultation('c0000000-0000-4000-8000-000000000001', 'confirmed', '2026-09-08T10:00:00Z'),
        consultation('c0000000-0000-4000-8000-000000000002', 'confirmed', '2026-09-09T10:00:00Z'),
        consultation('c0000000-0000-4000-8000-000000000003', 'confirmed', '2026-09-12T10:00:00Z'),
        consultation('c0000000-0000-4000-8000-000000000004', 'cancelled', '2026-09-07T10:00:00Z'),
      ],
    });

    const heading = await screen.findByRole('heading', { level: 2, name: 'Consultations: did they take place?' });
    const section = heading.closest('section') as HTMLElement;
    // The two ended ones only: not the upcoming one, not the cancelled one.
    expect(within(section).getAllByRole('button', { name: /^Took place:/ })).toHaveLength(2);

    fireEvent.click(within(section).getAllByRole('button', { name: /^Took place:/ })[0]);
    await waitFor(() => {
      expect(rpcCalls).toContainEqual({
        name: 'set_appointment_status',
        args: { p_appointment_id: 'c0000000-0000-4000-8000-000000000002', p_status: 'completed' },
      });
    });
    fireEvent.click(within(section).getAllByRole('button', { name: /^Client did not come:/ })[1]);
    await waitFor(() => {
      expect(rpcCalls).toContainEqual({
        name: 'set_appointment_status',
        args: { p_appointment_id: 'c0000000-0000-4000-8000-000000000001', p_status: 'no_show' },
      });
    });
  });

  it('shows a later tattoo booking as a hint only, leaving the answer to the operator', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
      rpcCalls,
      extraSessions: [
        consultation('c0000000-0000-4000-8000-000000000001', 'confirmed', '2026-09-08T10:00:00Z'),
        {
          ...consultation('c0000000-0000-4000-8000-000000000009', 'confirmed', '2026-10-01T10:00:00Z', 420),
          appointment_type: 'tattoo_session',
          created_at: '2026-09-08T12:00:00Z',
        },
      ],
    });
    const heading = await screen.findByRole('heading', { level: 2, name: 'Consultations: did they take place?' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findByText(/A hint only: it does not prove the consultation took place/)).toBeInTheDocument();
    // Both answers are still offered, and nothing was recorded on its own.
    expect(within(section).getByRole('button', { name: /^Took place:/ })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: /^Client did not come:/ })).toBeInTheDocument();
    expect(rpcCalls.some((call) => call.name === 'set_appointment_status')).toBe(false);
  });

  it('shows nothing to a viewer who cannot change appointments', async () => {
    renderWithSession(<App />, {
      role: 'read_only',
      path: '/appointments',
      extraSessions: [consultation('c0000000-0000-4000-8000-000000000001', 'confirmed', '2026-09-08T10:00:00Z')],
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Consultations: did they take place?' })).not.toBeInTheDocument();
  });
});
