// Booking, as an operator does it.
//
// Three forms used to book appointments, with three field sets and two
// conflict policies. There is one now, and these tests hold that consolidation
// in place: whichever screen the operator started from, the same panel asks
// the same questions, links the same records and reports the same outcome.
//
// One behaviour deliberately changed with 0120. The old form disabled its
// submit button until a clash was acknowledged, because nothing else would
// have stopped the booking. The database refuses a real clash now, so the
// panel warns and stays pressable: disabling it would only hide why.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  PROJECT_ID,
  SCHEDULED_APPOINTMENT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-08-30T09:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

async function chooseClientOnCalendar(options: Record<string, unknown> = {}) {
  const rendered = renderWithSession(<App />, {
    role: 'booking_manager',
    path: '/appointments',
    accessibleArtistIds: [VLADIMIR_ARTIST_ID],
    ...options,
  });
  const search = await screen.findByLabelText('Find the client');
  fireEvent.change(search, { target: { value: 'Fixture' } });
  fireEvent.click(await screen.findByRole('button', { name: /Fixture Client/ }, { timeout: 3000 }));
  return rendered;
}

describe('choosing a client', () => {
  it('searches rather than listing every client in a native picker', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
    });

    // A studio with a thousand clients cannot be a <select>. The picker asks
    // for a search term and queries the server.
    expect(await screen.findByLabelText('Find the client')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Client' })).not.toBeInTheDocument();
  });

  it('finds a client by what they contacted you with, then names the chosen one', async () => {
    await chooseClientOnCalendar();

    // Once chosen the client stays named, so the operator is never booking
    // against a uuid they cannot verify.
    expect(await screen.findByRole('combobox', { name: 'Appointment type' })).toBeInTheDocument();
    expect(screen.getAllByText(/Fixture Client/).length).toBeGreaterThan(0);
  });

  it('offers the client own projects to link the booking to', async () => {
    await chooseClientOnCalendar();

    // A tattoo session belongs to a project, and the project is named rather
    // than identified by a reference the operator would have to look up.
    const project = await screen.findByRole('combobox', { name: /^Project/ });
    expect(within(project).getByRole('option', { name: 'Raven sleeve' })).toBeInTheDocument();
  });
});

describe('one booking behaviour', () => {
  it('books through the shared panel and says what was booked, for whom and when', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    await chooseClientOnCalendar({ rpcCalls });

    fireEvent.change(await screen.findByRole('combobox', { name: /^Project/ }), {
      target: { value: PROJECT_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enter a time myself' }));
    fireEvent.change(await screen.findByLabelText('Start'), {
      target: { value: '2026-09-02T10:00' },
    });
    fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '2026-09-02T17:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Book this exact time' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'schedule_appointment');
      expect(call?.args?.p_client_id).toBe(CLIENT_ID);
      // The link the old form carried is carried here.
      expect(call?.args?.p_project_id).toBe(PROJECT_ID);
      expect(call?.args?.p_artist_id).toBe(VLADIMIR_ARTIST_ID);
    });

    expect(await screen.findByText(/Booked\./)).toBeInTheDocument();
    expect(SCHEDULED_APPOINTMENT_ID).toBeTruthy();
  });

  it('warns about a real clash before submitting, and still lets the database decide', async () => {
    await chooseClientOnCalendar();

    fireEvent.click(screen.getByRole('button', { name: 'Enter a time myself' }));
    // The fixture artist already has a session in this window.
    fireEvent.change(await screen.findByLabelText('Start'), {
      target: { value: '2026-09-01T11:00' },
    });
    fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '2026-09-01T13:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check this time' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/will be refused/);
    // Not disabled: the database is what refuses, and hiding the button would
    // hide the reason.
    expect(screen.getByRole('button', { name: 'Book this exact time' })).not.toBeDisabled();
  });

  it('separates an overlap that refuses the booking from one that merely coincides', async () => {
    await chooseClientOnCalendar();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Appointment type' }), {
      target: { value: 'in_person_consultation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enter a time myself' }));
    fireEvent.change(await screen.findByLabelText('Start'), {
      target: { value: '2026-09-01T11:00' },
    });
    fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '2026-09-01T11:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check this time' }));

    // A consultation during a tattoo session is reported, not refused - which
    // is exactly the rule the database now applies.
    expect(await screen.findByText(/do not block this one/)).toBeInTheDocument();
    expect(screen.queryByText(/will be refused/)).not.toBeInTheDocument();
  });
});
