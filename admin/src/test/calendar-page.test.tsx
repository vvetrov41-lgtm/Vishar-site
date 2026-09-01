// The schedule, as an operator reads it in the month calendar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { App } from '../App';
import { SESSION, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

// The morning of the fixture booking, so the calendar is deterministic and the
// fixture session falls on today.
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

describe('the schedule as a month calendar', () => {
  it('renders a conventional six-week month grid and marks today', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    const monthSection = (await screen.findByRole('heading', { level: 2, name: 'Month' }))
      .closest('section') as HTMLElement;
    const grid = within(monthSection).getByRole('grid', { name: 'September 2026' });

    expect(within(grid).getAllByRole('columnheader')).toHaveLength(7);
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(42);
    expect(within(grid).getByRole('gridcell', { name: 'Tue 1 Sept' })).toHaveClass('today');
    expect(within(monthSection).getByRole('button', { name: 'Today' })).toBeInTheDocument();
  });

  it("selects today's booking by default and keeps its operator controls", async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    expect(await screen.findByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Client: Fixture Client/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Confirm:/ })).toBeInTheDocument();
    expect(SESSION.start_at).toBe('2026-09-01T10:00:00Z');
  });

  it('shows multi-day time off in the month and its detail when selected', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
      availabilityBlocks: [DAY_OFF],
    });

    const grid = await screen.findByRole('grid', { name: 'September 2026' });
    expect(within(grid).getAllByText('Holiday')).toHaveLength(2);

    fireEvent.click(within(grid).getByRole('gridcell', { name: 'Thu 3 Sept' }));

    const detail = screen.getByRole('heading', { level: 2, name: /3 Sept/ }).closest('section') as HTMLElement;
    expect(within(detail).getByText('Holiday')).toBeInTheDocument();
    expect(within(detail).getByText(/All day/)).toBeInTheDocument();
    expect(within(detail).getByText(/Away/)).toBeInTheDocument();
  });

  it('keeps later dates reachable with month navigation and Today', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    const september = (await screen.findByRole('grid', { name: 'September 2026' }))
      .closest('section') as HTMLElement;
    fireEvent.click(within(september).getByRole('button', { name: 'Next month' }));

    expect(await screen.findByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
  });
});
