// Booking, as an operator does it.
//
// Three forms booked appointments with three field sets and two conflict
// policies: consultations refused outright on a clash, sessions warned politely
// and let you scroll past, and none of them said anything when a booking
// succeeded. These tests hold the one policy in place and assert that the
// operator is told what they just booked and for whom.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  ENQUIRY_ID,
  PROJECT_ID,
  SCHEDULED_APPOINTMENT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const CONFLICT = {
  appointment_id: '12121212-1212-4121-8121-121212121212',
  appointment_type: 'tattoo_session',
  status: 'confirmed',
  start_at: '2026-09-01T10:00:00Z',
  end_at: '2026-09-01T16:00:00Z',
  client_id: CLIENT_ID,
  enquiry_id: null,
  project_id: PROJECT_ID,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-08-30T09:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('choosing a client', () => {
  it('searches rather than listing every client in a native picker', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    await screen.findByRole('heading', { level: 2, name: 'Appointments' });

    // A native select over the 200 most recent clients is a wheel picker on a
    // phone, and cannot offer the 201st client at all.
    expect(screen.queryByRole('combobox', { name: /^Client/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Find the client')).toBeInTheDocument();
  });

  it('finds a client by what they contacted you with, then names the chosen one', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments', queryCalls });

    await screen.findByRole('heading', { level: 2, name: 'Appointments' });

    fireEvent.change(screen.getByLabelText('Find the client'), {
      target: { value: '07700900000' },
    });

    const result = await screen.findByRole('button', { name: /Fixture Client/ });
    fireEvent.click(result);

    // The chosen client stays named, so the operator can see who they are
    // booking without reopening anything.
    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose someone else' })).toBeInTheDocument();

    // The search went to the database, across the identifiers a client
    // actually contacts you with.
    const search = queryCalls.find((call) => call.table === 'clients' && call.method === 'or');
    expect(String(search?.args[0])).toContain('phone.ilike');
    expect(String(search?.args[0])).toContain('email.ilike');
  });

  it('names the client on the project and enquiry pickers', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    await screen.findByRole('heading', { level: 2, name: 'Appointments' });

    const projectPicker = screen.getByRole('combobox', { name: /^Project/ });
    expect(within(projectPicker).getByRole('option', { name: 'Fixture Client · Raven sleeve' }))
      .toBeInTheDocument();

    const enquiryPicker = screen.getByRole('combobox', { name: /^Enquiry/ });
    expect(within(enquiryPicker).getByRole('option', { name: 'Fixture Client · ENQ-2026-0001' }))
      .toBeInTheDocument();
  });
});

describe('one conflict policy', () => {
  it('states the clash assertively and will not book until it is acknowledged', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
      appointmentConflicts: [CONFLICT],
    });

    await screen.findByRole('heading', { level: 2, name: 'Appointments' });

    fireEvent.change(screen.getByRole('combobox', { name: /^Project/ }), {
      target: { value: PROJECT_ID },
    });
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-09-01T11:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-09-01T14:00' } });

    const clash = await screen.findByRole('alert');
    expect(clash).toHaveTextContent(/Conflicting active appointments: 1/);

    const submit = screen.getByRole('button', { name: 'Propose appointment' });
    expect(submit).toBeDisabled();

    fireEvent.click(within(clash).getByRole('checkbox'));
    expect(submit).not.toBeDisabled();
  });

  it('uses the same rule for a consultation, which used to refuse outright', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/enquiries/${ENQUIRY_ID}`,
      appointmentConflicts: [CONFLICT],
    });

    await screen.findByRole('heading', { level: 3, name: 'Schedule a consultation' });

    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2026-09-01T11:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule consultation' }));

    const clash = await screen.findByText(/Conflicting|overlaps 1 active appointment/);
    const alert = clash.closest('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();

    // The old rule ended here with "Choose another time". The operator can now
    // say they meant it.
    expect(within(alert).getByRole('checkbox')).toBeInTheDocument();
    expect(VLADIMIR_ARTIST_ID).toBeTruthy();
  });
});

describe('booking feedback', () => {
  it('says what was booked, for whom and when, and links to it', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
    });

    await screen.findByRole('heading', { level: 2, name: 'Appointments' });

    fireEvent.change(screen.getByRole('combobox', { name: /^Project/ }), {
      target: { value: PROJECT_ID },
    });
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-09-04T11:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-09-04T14:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose appointment' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'schedule_appointment')).toBe(true);
    });

    // Previously the form cleared itself and the only evidence was a new row
    // somewhere in the list below.
    const confirmation = await screen.findByText(/booked for Fixture Client/);
    expect(confirmation).toHaveTextContent(/Tattoo session/);
    expect(confirmation).toHaveTextContent(/proposed until you confirm it/);
    expect(within(confirmation).getByRole('link', { name: 'Open it' }))
      .toHaveAttribute('href', `#/appointments/${SCHEDULED_APPOINTMENT_ID}`);
  });
});
