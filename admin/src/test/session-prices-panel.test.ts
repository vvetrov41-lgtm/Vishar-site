import { describe, expect, it } from 'vitest';
import { sessionsNeedingPrice } from '../components/SessionPricesPanel';
import type { Appointment } from '../lib/appointment-api';

const now = Date.parse('2026-10-01T10:00:00Z');
const base = {
  artist_id: 'a', client_id: 'c', enquiry_id: null, project_id: 'p', duration_hours: 7, currency: 'GBP',
  payment_status: 'unpaid', calendar_provider: 'none', calendar_event_id: null, calendar_version: 0,
  calendar_sync_status: 'not_connected',
} as unknown as Appointment;
const make = (id: string, extra: Partial<Appointment>): Appointment => ({
  ...base, id, appointment_type: 'tattoo_session', status: 'confirmed',
  start_at: '2026-11-07T11:00:00Z', end_at: '2026-11-07T18:00:00Z', ...extra,
} as Appointment);

describe('sessionsNeedingPrice', () => {
  it('lists only upcoming booked tattoo sessions without a price, in date order', () => {
    const rows = [
      make('later', { start_at: '2026-11-08T11:00:00Z', end_at: '2026-11-08T18:00:00Z' }),
      make('priced', {}),
      make('first', {}),
      make('consult', { appointment_type: 'in_person_consultation' }),
      make('cancelled', { status: 'cancelled' }),
      make('past', { start_at: '2026-09-01T11:00:00Z', end_at: '2026-09-01T18:00:00Z' }),
      make('proposed', { status: 'proposed', start_at: '2026-11-09T11:00:00Z', end_at: '2026-11-09T15:00:00Z' }),
    ];
    const price = (id: string) => (id === 'priced' ? 980 : null);
    expect(sessionsNeedingPrice(rows, price, now).map((row) => row.id)).toEqual(['first', 'later', 'proposed']);
  });
});
