import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { addHoursToLocalDateTime, findSessionConflicts } from '../lib/session-planning';
import {
  PROJECT_ID,
  SESSION,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

function toLocalInput(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe('session planning helpers', () => {
  it('sets a local end time from a duration shortcut', () => {
    expect(addHoursToLocalDateTime('2026-09-10T11:30', 7)).toBe('2026-09-10T18:30');
  });

  it('finds only active overlapping sessions', () => {
    const cancelled = { ...SESSION, id: 'cancelled', status: 'cancelled' as const };
    const existingStart = toLocalInput(SESSION.start_at);
    const overlappingStart = addHoursToLocalDateTime(existingStart, 1);
    const overlappingEnd = addHoursToLocalDateTime(existingStart, 2);
    const adjacentStart = toLocalInput(SESSION.end_at);
    const adjacentEnd = addHoursToLocalDateTime(adjacentStart, 1);

    expect(findSessionConflicts(
      [SESSION, cancelled],
      overlappingStart,
      overlappingEnd
    )).toEqual([SESSION]);
    expect(findSessionConflicts(
      [SESSION],
      adjacentStart,
      adjacentEnd
    )).toEqual([]);
  });
});

describe('project session planner', () => {
  it('offers 3, 5 and 7 hour shortcuts and warns about an artist overlap', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/projects/${PROJECT_ID}`,
      queryCalls,
    });

    const start = await screen.findByLabelText('Proposed start');
    const end = screen.getByLabelText('Proposed end');
    const threeHours = screen.getByRole('button', { name: '3 h' });

    expect(threeHours).toBeDisabled();
    expect(screen.getByRole('button', { name: '5 h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 h' })).toBeInTheDocument();

    const existingStart = toLocalInput(SESSION.start_at);
    const overlappingStart = addHoursToLocalDateTime(existingStart, 1);
    const expectedEnd = addHoursToLocalDateTime(overlappingStart, 3);

    fireEvent.change(start, { target: { value: overlappingStart } });
    fireEvent.click(threeHours);

    expect(end).toHaveValue(expectedEnd);
    expect(screen.getByRole('alert')).toHaveTextContent('Conflicting active sessions: 1');

    await waitFor(() => {
      expect(queryCalls).toContainEqual({
        table: 'sessions',
        method: 'eq',
        args: ['artist_id', VLADIMIR_ARTIST_ID],
      });
    });
  });
});
