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
const RESIZE_TARGET = 'Set end on Tue 1 Sept at 18:00';
const RESIZED_END = '2026-09-01T17:00:00.000Z';

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

const RESIZE_CLASH = {
  ...CLASHING_APPOINTMENT,
  start_at: '2026-09-01T16:30:00Z',
  end_at: '2026-09-01T17:30:00Z',
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

  it('reveals trailing end-time targets so the latest appointment can be extended', async () => {
    await openWeek({ role: 'booking_manager' });

    // The ordinary grid ends at the default 20:00 boundary for this fixture.
    // Activating resize must expose rows below that boundary, otherwise an
    // appointment ending at 20:00 could only be shortened.
    fireEvent.click(await screen.findByRole('button', { name: /^Change duration: Tattoo session/ }));
    expect(await screen.findByRole('button', { name: 'Set end on Tue 1 Sept at 22:00' }))
      .toBeInTheDocument();
  });

  it('changes duration through the keyboard/touch target path', async () => {
    const { rpcCalls } = await openWeek({ role: 'booking_manager' });

    fireEvent.click(await screen.findByRole('button', { name: /^Change duration: Tattoo session/ }));
    fireEvent.click(await screen.findByRole('button', { name: RESIZE_TARGET }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'reschedule_appointment')).toBe(true);
    });

    const conflictCall = rpcCalls.find((entry) => entry.name === 'list_appointment_conflicts');
    expect(conflictCall?.args).toMatchObject({
      p_artist_id: VLADIMIR_ARTIST_ID,
      p_start_at: SESSION.start_at,
      p_end_at: RESIZED_END,
      p_exclude_appointment_id: SESSION_ID,
    });

    const call = rpcCalls.find((entry) => entry.name === 'reschedule_appointment');
    expect(call?.args).toMatchObject({
      p_appointment_id: SESSION_ID,
      p_start_at: SESSION.start_at,
      p_end_at: RESIZED_END,
    });
  });

  it('keeps the old duration when the resized window conflicts', async () => {
    const { rpcCalls } = await openWeek({
      role: 'booking_manager',
      appointmentConflicts: [RESIZE_CLASH],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Change duration: Tattoo session/ }));
    fireEvent.click(await screen.findByRole('button', { name: RESIZE_TARGET }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That duration overlaps another appointment (17:30–18:30). The duration has not changed.'
    );
    expect(rpcCalls.some((call) => call.name === 'reschedule_appointment')).toBe(false);
    const block = (await screen.findByText('Fixture Client')).closest('.week-event');
    expect(block).toHaveTextContent('11:00–17:00');
  });

  it('rolls the duration back when the server refuses the resize', async () => {
    await openWeek({
      role: 'booking_manager',
      failRpc: 'reschedule_appointment',
      failRpcError: {
        code: '22023',
        message: 'artist availability blocks this time',
        hint: 'SLOT_NO_LONGER_AVAILABLE',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Change duration: Tattoo session/ }));
    fireEvent.click(await screen.findByRole('button', { name: RESIZE_TARGET }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const block = (await screen.findByText('Fixture Client')).closest('.week-event');
    expect(block).toHaveTextContent('11:00–17:00');
  });

  it('changes duration by dragging the lower edge onto a slot', async () => {
    const { rpcCalls } = await openWeek({ role: 'owner' });

    const handle = await screen.findByRole('button', { name: /^Change duration: Tattoo session/ });
    fireEvent.click(handle);
    const slot = screen.getByRole('button', { name: RESIZE_TARGET }).parentElement as HTMLElement;

    fireEvent.dragStart(handle, {
      dataTransfer: {
        setData: () => {},
        getData: () => `resize:${SESSION_ID}`,
      },
    });
    fireEvent.drop(slot, {
      dataTransfer: {
        getData: () => `resize:${SESSION_ID}`,
      },
    });

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'reschedule_appointment')).toBe(true);
    });
    expect(rpcCalls.find((entry) => entry.name === 'reschedule_appointment')?.args)
      .toMatchObject({ p_end_at: RESIZED_END });
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

describe('what the grid asks the server for', () => {
  // Sunday 23:00 BST to Monday 02:00 BST, so it starts before the Monday the
  // week begins on and is still running inside it.
  const OVERNIGHT = {
    id: '88888888-8888-4888-8888-888888888888',
    artist_id: VLADIMIR_ARTIST_ID,
    client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    project_id: null,
    enquiry_id: null,
    appointment_type: 'tattoo_session',
    status: 'confirmed',
    start_at: '2026-08-30T22:00:00Z',
    end_at: '2026-08-31T01:00:00Z',
    duration_hours: 3,
    currency: 'GBP',
    payment_status: 'unpaid',
    calendar_provider: 'none',
    calendar_event_id: null,
    calendar_version: 0,
    notes: null,
    cancelled_at: null,
  };

  it('bounds the window by overlap, so an overnight booking is not lost', async () => {
    // `renderWithSession` hands back the RPC log but not the PostgREST one, so
    // the array is held here and passed in.
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    const { container } = await openWeek({
      role: 'booking_manager',
      extraSessions: [OVERNIGHT],
      queryCalls,
    });

    // Both bookings belong to the fixture client, so two labels is itself the
    // evidence that the overnight one survived the window.
    expect(await screen.findAllByText('Fixture Client')).toHaveLength(2);

    // Bounding on start_at alone would have excluded it: it starts an hour
    // before the window opens.
    const sessionBounds = queryCalls.filter(
      (call) => call.table === 'sessions' && (call.method === 'gt' || call.method === 'gte')
    );
    expect(sessionBounds.some((call) => call.method === 'gt' && call.args[0] === 'end_at')).toBe(true);
    expect(sessionBounds.some((call) => call.args[0] === 'start_at')).toBe(false);

    // Two blocks in the grid: the fixture booking and the overnight one.
    expect(container.querySelectorAll('.week-event').length).toBe(2);
  });

  it('keeps the hour ruler independent of what is booked in it', async () => {
    const { container } = await openWeek({ role: 'booking_manager' });

    await screen.findByText('Fixture Client');
    const gutterRows = container.querySelectorAll('.week-gutter-slot').length;
    const firstDaySlots = container.querySelectorAll('.week-day')[0]
      .querySelectorAll('.week-slot').length;

    // One row per slot in every column, whatever length the bookings are: a
    // six-hour block that stretched its own slot would knock every later hour
    // label out of line.
    expect(firstDaySlots).toBe(gutterRows);

    // And the blocks live in their own layer rather than inside a slot.
    const block = (screen.getByText('Fixture Client')).closest('.week-event') as HTMLElement;
    expect(block.parentElement).toHaveClass('week-day-events');
    expect(block.closest('.week-slot')).toBeNull();
  });
});

describe('who may move an appointment', () => {
  it('offers nothing to a read-only account', async () => {
    await openWeek({ role: 'read_only' });

    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move: / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Change duration: / })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: /^Change duration: / })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: /^Change duration: / })).not.toBeInTheDocument();
  });

  it('offers the move to the owner, who holds every artist', async () => {
    await openWeek({ role: 'owner' });

    expect(await screen.findByRole('button', { name: /^Move: Tattoo session/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Change duration: Tattoo session/ })).toBeInTheDocument();
    expect(OWNER_ID).toBeTruthy();
  });
});
