import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { renderWithSession } from './fixtures';
import { addHoursToLocalDateTime, findSessionConflicts } from '../lib/session-planning';
import {
  PROJECT_ID,
  SESSION,
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

describe('project appointment planner', () => {
  it('books an extra session through the one shared panel', async () => {
    // The project used to carry its own inline planner with its own duration
    // shortcuts and its own clash warning. It is gone: this is the same panel
    // the client workspace, the enquiry and the Calendar use, so there is one
    // booking behaviour to reason about rather than four.
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });

    expect(await screen.findByRole('heading', { name: 'Book a session' })).toBeInTheDocument();
    expect(screen.queryByText('Add another appointment')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find free times' })).toBeInTheDocument();

    // The project is already known, so the panel does not ask again. (The
    // page's own "Project status" control is a different question.)
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
  });
});
