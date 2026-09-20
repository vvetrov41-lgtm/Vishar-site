// Moving an appointment in the week grid.
//
// The server decides. These tests pin the three answers it can give - yes, the
// slot is taken, and no - and what the grid does with each of them, plus who
// is offered the affordance at all.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import {
  KRISTINA_ARTIST_ID,
  MANAGER_ID,
  OWNER_ID,
  SESSION,
  SESSION_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

// Tuesday 1 September 2026, the morning of the fixture booking. Europe/London
// is on BST, so the stored 10:00Z booking reads as 11:00 in the CRM.
const NOW = new Date('2026-09-01T08:00:00Z');

/** Wednesday 2 September at 13:00 BST. */
const TARGET_SLOT = 'Move to Wed 2 Sept at 13:00';
const EXPECTED_START = '2026-09-02T12:00:00.000Z';
const EXPECTED_END = '2026-09-02T18:00:00.000Z';

const CLASHING_APPOINTMENT = {
  appointment_id: '77777777-7777-4777-8777-777777777777',
  appointment_type: 'tattoo_session',
  status: 'confirmed',
  start_at: '2026-09-02T11:00:00Z',
  end_at: '2026-09-02T15:00:00Z',
  client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  enquiry_id: null,
  project_id: null,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

async function openWeek(options: Parameters<typeof renderWithSession>[1]) {
  const result = renderWithSession(<App />, { path: '/appointments', ...options });
  fireEvent.click(await screen.findByRole('button', { name: 'Week' }));
  return result;
}

describe('the manager week grid', () => {
  it('shows the booking on its own day at the artist wall-clock time', async () => {
    await openWeek({ role: 'booking_manager' });

    const block = await screen.findByText('Fixture Client');
    expect(block.closest('.week-event')).toHaveTextContent('11:00–17:00');
    expect(screen.getByText('Times are shown in Europe/London.')).toBeInTheDocument();
    expect(SESSION.start_at).toBe('2026-09-01T10:00:00Z');
  });

  it('saves a move the server accepts', async () => {
    const { rpcCalls } = await openWeek({ role: 'booking_manager' });

    fireEvent.click(await screen.findByRole('button', { name: /^Move: Tattoo session/ }));
    fireEvent.click(await screen.findByRole('button', { name: TARGET_SLOT }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'reschedule_appointment')).toBe(true);
    });
    const call = rpcCalls.find((entry) => entry.name === 'reschedule_appointment');
    expect(call?.args).toMatchObject({
      p_appointment_id: SESSION_ID,
      p_start_at: EXPECTED_START,
      p_end_at: EXPECTED_END,
    });
  });

  it('asks the server about conflicts before it asks it to move anything', async () => {
    const { rpcCalls } = await openWeek({ role: 'booking_manager' });

    fireEvent.click(await screen.findByRole('button', { name: /^Move: Tattoo session/ }));
    fireEvent.click(await screen.findByRole('button', { name: TARGET_SLOT }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'reschedule_appointment')).toBe(true);
    });
    const names = rpcCalls.map((call) => call.name);
    expect(names.indexOf('list_appointment_conflicts'))
      .toBeLessThan(names.indexOf('reschedule_appointment'));
    expect(rpcCalls.find((call) => call.name === 'list_appointment_conflicts')?.args)
      .toMatchObject({
        p_artist_id: VLADIMIR_ARTIST_ID,
        p_exclude_appointment_id: SESSION_ID,
      });
  });

  it('leaves the appointment where it was when the slot is taken', async () => {
    const { rpcCalls } = await openWeek({
      role: 'booking_manager',
      appointmentConflicts: [CLASHING_APPOINTMENT],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Move: Tattoo session/ }));
    fireEvent.click(await screen.findByRole('button', { name: TARGET_SLOT }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That time is already taken (12:00–16:00). The appointment has not moved.'
    );
    expect(rpcCalls.some((call) => call.name === 'reschedule_appointment')).toBe(false);
    const block = (await screen.findByText('Fixture Client')).closest('.week-event');
    expect(block).toHaveTextContent('11:00–17:00');
  });

  it('puts the appointment back when the server refuses the move', async () => {
    await openWeek({
      role: 'booking_manager',
      failRpc: 'reschedule_appointment',
      failRpcError: {
        code: '22023',
        message: 'artist availability blocks this time',
        hint: 'SLOT_NO_LONGER_AVAILABLE',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Move: Tattoo session/ }));
    fireEvent.click(await screen.findByRole('button', { name: TARGET_SLOT }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const block = (await screen.findByText('Fixture Client')).closest('.week-event');
    expect(block).toHaveTextContent('11:00–17:00');
  });

  it('moves an appointment dropped on a slot with a pointer', async () => {
    const { container, rpcCalls } = await openWeek({ role: 'owner' });

    const block = (await screen.findByText('Fixture Client')).closest('.week-event') as HTMLElement;
    expect(block).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(block, { dataTransfer: { setData: () => {}, getData: () => SESSION_ID } });

    // Wednesday is the third column; its slots carry the same minutes as the
    // keyboard targets, so this is the same drop the button above performs.
    fireEvent.click(await screen.findByRole('button', { name: /^Move: Tattoo session/ }));
    const slot = screen.getByRole('button', { name: TARGET_SLOT }).parentElement as HTMLElement;
    fireEvent.drop(slot, { dataTransfer: { getData: () => SESSION_ID } });

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'reschedule_appointment')).toBe(true);
    });
    expect(container.querySelectorAll('.week-event').length).toBeGreaterThan(0);
  });
});

describe('who may move an appointment', () => {
  it('offers nothing to a read-only account', async () => {
    await openWeek({ role: 'read_only' });

    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move: / })).not.toBeInTheDocument();
    const block = (screen.getByText('Fixture Client')).closest('.week-event');
    expect(block).toHaveAttribute('draggable', 'false');
  });

  it('offers nothing to a manager whose membership cannot manage that artist schedule', async () => {
    await openWeek({
      role: 'booking_manager',
      membershipOverrides: [{
        profile_id: MANAGER_ID,
        artist_id: VLADIMIR_ARTIST_ID,
        access_level: 'manager',
        can_view_finance: false,
        can_manage_finance: false,
        can_manage_sessions: false,
        can_manage_integrations: false,
        is_active: true,
      }],
    });

    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move: / })).not.toBeInTheDocument();
  });

  it('keeps Vladimir and Kristina apart: a Kristina-only manager cannot move a Vladimir booking', async () => {
    await openWeek({
      role: 'booking_manager',
      membershipOverrides: [{
        profile_id: MANAGER_ID,
        artist_id: KRISTINA_ARTIST_ID,
        access_level: 'manager',
        can_view_finance: false,
        can_manage_finance: false,
        can_manage_sessions: true,
        can_manage_integrations: false,
        is_active: true,
      }],
    });

    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move: / })).not.toBeInTheDocument();
  });

  it('offers the move to the owner, who holds every artist', async () => {
    await openWeek({ role: 'owner' });

    expect(await screen.findByRole('button', { name: /^Move: Tattoo session/ })).toBeInTheDocument();
    expect(OWNER_ID).toBeTruthy();
  });
});
