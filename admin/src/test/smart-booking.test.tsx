// Booking by asking, rather than by reading a calendar grid.
//
// The acceptance criteria here are operational: a seven-hour session, a short
// consultation, time off, an existing appointment, and the race where the
// schedule changes between a slot being offered and being confirmed. The last
// one matters most - the database holds the schedule lock, so the test proves
// the interface reports the refusal rather than pretending it booked.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

/** Local, because an operator books a local Friday, not a UTC one. */
function local(day: string, hour: number, minute = 0): string {
  const date = new Date(`${day}T00:00:00`);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function dayValue(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

async function openPanel(options: Record<string, unknown> = {}) {
  const rendered = renderWithSession(<App />, {
    role: 'owner',
    path: `/clients/${CLIENT_ID}`,
    ...options,
  });
  // Search from tomorrow, so "never offer the past" cannot make the result
  // depend on the hour the suite happens to run at.
  const from = await screen.findByLabelText('Search from');
  fireEvent.change(from, { target: { value: dayValue(1) } });
  return rendered;
}

describe('booking a session by asking for one', () => {
  it('offers only valid free times for a seven-hour tattoo session', async () => {
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    expect(slots.length).toBeGreaterThan(0);
    // Every offered slot states how much room it sits in, which is what makes
    // it checkable rather than a bare time.
    expect(slots[0]).toHaveTextContent(/\d+ h free here/);
  });

  it('books the chosen slot through the appointment RPC, after a summary', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    await openPanel({ rpcCalls });

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    fireEvent.click(slots[0]);

    // A summary in words before anything is written: who, what, when, how long.
    const summary = await screen.findByRole('group', { name: 'Booking summary' });
    expect(summary).toHaveTextContent(/Tattoo session for Fixture Client/);
    expect(summary).toHaveTextContent(/7 h/);

    fireEvent.click(within(summary).getByRole('button', { name: 'Book it' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'schedule_appointment');
      expect(call?.args?.p_artist_id).toBe(VLADIMIR_ARTIST_ID);
      expect(call?.args?.p_client_id).toBe(CLIENT_ID);
      expect(call?.args?.p_appointment_type).toBe('tattoo_session');
      // Proposed, not confirmed: the client has not agreed yet.
      expect(call?.args?.p_status).toBe('proposed');
    });
  });

  it('finds a short consultation slot where a long session does not fit', async () => {
    await openPanel();

    fireEvent.change(screen.getByLabelText('Appointment type'), {
      target: { value: 'in_person_consultation' },
    });
    fireEvent.click(screen.getByRole('button', { name: '30 min' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    expect(slots.length).toBeGreaterThan(0);
  });

  it('never offers a period that overlaps an existing appointment', async () => {
    // The fixture artist already has a session in the diary. Whatever the
    // search returns must not touch it.
    const { rpcCalls } = await openPanel({
      extraSessions: [{
        id: '11111111-2222-4333-8444-555555555555',
        artist_id: VLADIMIR_ARTIST_ID,
        client_id: CLIENT_ID,
        enquiry_id: null,
        project_id: null,
        appointment_type: 'tattoo_session',
        status: 'confirmed',
        start_at: local(dayValue(1), 10),
        end_at: local(dayValue(1), 20),
        duration_hours: 10,
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
      }],
    });
    expect(rpcCalls).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    // The blocked day is full from 10:00 to 20:00, so nothing on it can be
    // offered inside a 10:00-20:00 search window.
    const blockedHeading = new Date(`${dayValue(1)}T00:00:00`).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    expect(screen.queryByRole('heading', { name: blockedHeading })).not.toBeInTheDocument();
    expect(slots.length).toBeGreaterThan(0);
  });

  it('never offers a period inside time off', async () => {
    await openPanel({
      availabilityBlocks: [{
        block_id: 'block-1',
        artist_id: VLADIMIR_ARTIST_ID,
        block_kind: 'day_off',
        start_at: local(dayValue(1), 0),
        end_at: local(dayValue(2), 0),
        is_all_day: true,
        note: null,
        cancelled_at: null,
        created_at: local(dayValue(0), 9),
        updated_at: local(dayValue(0), 9),
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    await screen.findAllByRole('button', { name: /free here/ });
    const offHeading = new Date(`${dayValue(1)}T00:00:00`).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    expect(screen.queryByRole('heading', { name: offHeading })).not.toBeInTheDocument();
  });

  it('fails closed when the schedule changes between offering and confirming', async () => {
    // schedule_appointment takes crm_private.lock_artist_schedule and re-checks
    // availability inside the same transaction, so the database is what refuses
    // a stale slot. The interface must report that, not swallow it.
    await openPanel({ failRpc: 'schedule_appointment' });

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    fireEvent.click(slots[0]);
    const summary = await screen.findByRole('group', { name: 'Booking summary' });
    fireEvent.click(within(summary).getByRole('button', { name: 'Book it' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // And it says what to do about it, rather than leaving a dead summary.
    expect(await screen.findByText(/The schedule changed while you were deciding/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Booking summary' })).not.toBeInTheDocument();
  });

  it('takes the working window from the artist instead of asking for it', async () => {
    // The panel used to make the operator type 10:00-20:00 on every search,
    // because the schema had no working hours. It has them now (0120), so the
    // form asks for nothing and says which window it used.
    await openPanel();
    expect(screen.queryByLabelText('Not before')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Finished by')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));
    await screen.findAllByRole('button', { name: /free here/ });
    expect(screen.getByText(/Searching this artist’s hours: 09:00 to 18:00/)).toBeInTheDocument();
  });

  it('offers the studio\'s habitual starts first, and marks them', async () => {
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    // 09:00-16:00 and 11:00-18:00 are what this studio actually books.
    expect(slots[0]).toHaveTextContent('usual start');
    const labels = slots.map((slot) => slot.textContent ?? '');
    expect(labels.some((label) => label.startsWith('09:00'))).toBe(true);
    expect(labels.some((label) => label.startsWith('11:00'))).toBe(true);
  });

  it('never offers a tattoo start that would run past the artist finish time', async () => {
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    for (const slot of slots) {
      const hour = Number((slot.textContent ?? '').slice(0, 2));
      // 18:00 finish minus seven hours means nothing may start after 11:00.
      expect(hour).toBeLessThanOrEqual(11);
    }
  });

  it('keeps manual entry for a time the client already named', async () => {
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Enter a time myself' }));
    expect(await screen.findByText(/For a time the client has already named/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book this exact time' })).toBeInTheDocument();
  });

  it('offers two days in a row for a large piece', async () => {
    await openPanel();
    fireEvent.change(screen.getByLabelText('How many days'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const runs = await screen.findAllByRole('button', { name: /2 days in a row/ });
    expect(runs.length).toBeGreaterThan(0);
  });
});

describe('where booking is reachable from', () => {
  it('is on the client workspace', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });
    expect(await screen.findByRole('heading', { name: 'Book a session' })).toBeInTheDocument();
  });

  it('is on the calendar, and says what it is waiting for before it can search', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/appointments' });
    expect(await screen.findByRole('heading', { name: 'Find a time' })).toBeInTheDocument();
    // With no artist chosen the section still renders and says so, rather than
    // vanishing and leaving the operator to guess why.
    expect(screen.getByText('Choose an artist above to search for free times.')).toBeInTheDocument();
  });

  it('asks who the booking is for once an artist is in scope', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/appointments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
    });
    const scope = await screen.findByRole('combobox', { name: 'Artist' });
    fireEvent.change(scope, { target: { value: VLADIMIR_ARTIST_ID } });
    expect(await screen.findByText('Who is this for?')).toBeInTheDocument();
  });

  it('is hidden from a role that may not manage appointments', async () => {
    renderWithSession(<App />, { role: 'read_only', path: `/clients/${CLIENT_ID}` });
    await screen.findByText('Fixture Client');
    expect(screen.queryByRole('heading', { name: 'Book a session' })).not.toBeInTheDocument();
  });

  it('does not ask a phone operator to read a calendar grid', async () => {
    // The whole point on mobile: the answer is a list of times, and each one is
    // a full-width tap target rather than a cell to hit.
    const { container } = await openPanel();
    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    await screen.findAllByRole('button', { name: /free here/ });
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelectorAll('button.booking-slot').length).toBeGreaterThan(0);
  });
});

describe('shipping ahead of the migration', () => {
  it('still books when the scheduling RPCs are not in the database yet', async () => {
    // The CRM and the database ship through separate release paths, so a build
    // can reach production before migration 0120 does. In that window the
    // scheduling RPCs do not exist. Booking has to keep working on the same
    // defaults the migration will install, not fail with "function does not
    // exist" on every search.
    const rendered = renderWithSession(<App />, {
      role: 'owner',
      path: `/clients/${CLIENT_ID}`,
      failRpc: 'get_artist_scheduling_preferences',
      failRpcError: { code: 'PGRST202', message: 'Could not find the function' },
    });
    const from = await screen.findByLabelText('Search from');
    fireEvent.change(from, { target: { value: dayValue(1) } });

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    expect(slots.length).toBeGreaterThan(0);
    expect(rendered).toBeTruthy();
  });
});
