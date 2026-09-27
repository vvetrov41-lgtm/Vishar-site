import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { CLIENT_ID, PROJECT_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

const FUTURE_SESSION_ID = 'aaaa1111-2222-4333-8444-555566667777';

function futureDay(offsetDays: number, hour: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

describe('project session prices', () => {
  it('pre-fills an unpriced session from the project rate and saves only on confirmation', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: `/projects/${PROJECT_ID}`,
      extraSessions: [{
        id: FUTURE_SESSION_ID,
        artist_id: VLADIMIR_ARTIST_ID,
        client_id: CLIENT_ID,
        project_id: PROJECT_ID,
        enquiry_id: null,
        appointment_type: 'tattoo_session',
        status: 'confirmed',
        start_at: futureDay(40, 11),
        end_at: futureDay(40, 18),
        duration_hours: 7,
        currency: 'GBP',
        payment_status: 'unpaid',
        calendar_provider: 'none',
        calendar_event_id: null,
        calendar_version: 0,
        notes: null,
        cancelled_at: null,
      }],
    });

    const panel = await screen.findByRole('region', { name: 'Session prices' });
    const input = within(panel).getByLabelText('Session price');
    // The pre-fill arrives with the suggestion, which may be a moment later.
    await waitFor(() => expect(input).toHaveValue('980.00'));
    expect(panel).toHaveTextContent('Suggestion: £980 · 7 h × £140, from the project rate');
    expect(panel).toHaveTextContent('These are suggestions');

    fireEvent.click(within(panel).getByRole('button', { name: /Save prices \(1\)/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(rpcCalls.some((call) => call.name === 'set_appointment_price')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'set_appointment_price');
      expect(call?.args?.p_appointment_id).toBe(FUTURE_SESSION_ID);
      expect(call?.args?.p_price).toBe(980);
    });
  });
});

describe('pre-fill follows late suggestions but never overwrites typing', () => {
  it('keeps what the operator typed', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/projects/${PROJECT_ID}`,
      extraSessions: [{
        id: FUTURE_SESSION_ID, artist_id: VLADIMIR_ARTIST_ID, client_id: CLIENT_ID, project_id: PROJECT_ID,
        enquiry_id: null, appointment_type: 'tattoo_session', status: 'confirmed',
        start_at: futureDay(41, 11), end_at: futureDay(41, 18), duration_hours: 7, currency: 'GBP',
        payment_status: 'unpaid', calendar_provider: 'none', calendar_event_id: null, calendar_version: 0,
        notes: null, cancelled_at: null,
      }],
    });
    const panel = await screen.findByRole('region', { name: 'Session prices' });
    const input = within(panel).getByLabelText('Session price');
    await waitFor(() => expect(input).toHaveValue('980.00'));
    fireEvent.change(input, { target: { value: '1100' } });
    expect(input).toHaveValue('1100');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(input).toHaveValue('1100');
  });

  it('tells the operator that a legacy appointment gets no card when its price is saved', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: `/projects/${PROJECT_ID}`,
      bookingCardReason: 'appointment_before_activation',
      extraSessions: [{
        id: FUTURE_SESSION_ID,
        artist_id: VLADIMIR_ARTIST_ID,
        client_id: CLIENT_ID,
        project_id: PROJECT_ID,
        enquiry_id: null,
        appointment_type: 'tattoo_session',
        status: 'confirmed',
        start_at: futureDay(40, 11),
        end_at: futureDay(40, 18),
        duration_hours: 7,
        currency: 'GBP',
        payment_status: 'unpaid',
        calendar_provider: 'none',
        calendar_event_id: null,
        calendar_version: 0,
        notes: null,
        cancelled_at: null,
      }],
    });

    const panel = await screen.findByRole('region', { name: 'Session prices' });
    const input = within(panel).getByLabelText('Session price');
    await waitFor(() => expect(input).toHaveValue('980.00'));
    fireEvent.click(within(panel).getByRole('button', { name: /Save prices \(1\)/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('booked before booking cards were switched on, so no booking card goes to the client');
    expect(dialog).not.toHaveTextContent('straight away');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'set_appointment_price')).toBe(true);
    });
  });
});
