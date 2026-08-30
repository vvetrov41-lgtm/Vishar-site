// The schedule, as an operator reads it.
//
// `/appointments` showed one flat list of everything upcoming and one of
// everything past. There were no day boundaries, no marker for today, and time
// off - the other half of "when am I free?" - was on a different screen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { SESSION, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

// The morning of the fixture booking, so the diary window is the same on every
// run and the fixture session falls on "today".
const NOW = new Date('2026-09-01T08:00:00Z');

const DAY_OFF = {
  block_id: 'b1111111-1111-4111-8111-111111111111',
  artist_id: VLADIMIR_ARTIST_ID,
  block_kind: 'holiday',
  start_at: '2026-09-03T00:00:00Z',
  end_at: '2026-09-05T00:00:00Z',
  is_all_day: true,
  note: 'Away',
  cancelled_at: null,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the schedule as a diary', () => {
  it('groups the next two weeks into days and marks today', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    const diary = (await screen.findByRole('heading', { level: 2, name: 'Next 14 days' }))
      .closest('section') as HTMLElement;

    // Today is called out rather than left for the operator to work out from
    // the dates on consecutive rows.
    expect(within(diary).getByText('Today')).toBeInTheDocument();

    // Every day in the window appears, including the empty ones: "nothing on
    // Thursday" is the answer to "when am I free?".
    expect(within(diary).getAllByRole('heading', { level: 3 })).toHaveLength(14);
    expect(within(diary).getAllByText('Nothing booked').length).toBeGreaterThan(0);
  });

  it("puts today's booking under today", async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    const diary = (await screen.findByRole('heading', { level: 2, name: 'Next 14 days' }))
      .closest('section') as HTMLElement;

    const todayHeading = within(diary).getByText('Today').closest('h3') as HTMLElement;
    const todayGroup = todayHeading.parentElement as HTMLElement;

    expect(within(todayGroup).getByRole('link', { name: /Fixture Client/ })).toBeInTheDocument();
    expect(SESSION.start_at).toBe('2026-09-01T10:00:00Z');
  });

  it('shows time off beside bookings, on every day it covers', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
      availabilityBlocks: [DAY_OFF],
    });

    const diary = (await screen.findByRole('heading', { level: 2, name: 'Next 14 days' }))
      .closest('section') as HTMLElement;

    // A block spanning two days marks both, so no free-looking day appears in
    // the middle of a holiday.
    const holidays = within(diary).getAllByText('Holiday');
    expect(holidays).toHaveLength(2);
    expect(within(holidays[0].closest('.row') as HTMLElement).getByText(/All day/)).toBeInTheDocument();
  });

  it('keeps what is booked beyond the window reachable rather than hidden', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Further ahead' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Past' })).toBeInTheDocument();
  });
});
