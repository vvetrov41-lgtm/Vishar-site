import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { RouterProvider } from '../lib/router';
import { SessionProvider } from '../lib/session';
import { addHoursToLocalDateTime, findSessionConflicts } from '../lib/session-planning';
import {
  PROJECT_ID,
  SESSION,
  SESSION_ID,
  VLADIMIR_ARTIST_ID,
  createFakeClient,
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
  it('stays collapsed by default, then shows duration shortcuts and warns about a database-reported artist overlap', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const baseClient = createFakeClient({ role: 'booking_manager', rpcCalls });
    const client = {
      ...baseClient,
      rpc: async (name: string, args?: Record<string, unknown>) => {
        if (name === 'list_appointment_conflicts') {
          rpcCalls.push({ name, args });
          return {
            data: [{
              appointment_id: SESSION_ID,
              appointment_type: 'tattoo_session',
              status: 'proposed',
              start_at: SESSION.start_at,
              end_at: SESSION.end_at,
              client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              enquiry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              project_id: PROJECT_ID,
            }],
            error: null,
          };
        }
        return baseClient.rpc(name, args);
      },
    } as typeof baseClient;

    render(
      <SessionProvider client={client}>
        <RouterProvider initialPath={`/projects/${PROJECT_ID}`}>
          <App />
        </RouterProvider>
      </SessionProvider>
    );

    const disclosure = await screen.findByText('Add another appointment');
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('6 h')).toBeInTheDocument();

    fireEvent.click(disclosure);

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
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflicting active appointments: 1');

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'list_appointment_conflicts');
      expect(call).toBeDefined();
      expect(call!.args).toMatchObject({
        p_artist_id: VLADIMIR_ARTIST_ID,
      });
    });
  });
});
