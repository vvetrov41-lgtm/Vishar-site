// The client workspace, as an operator meets it.
//
// The audit's charge against the old client page was that six of the nine
// questions an operator asks about a client were unanswerable on it. These
// tests assert the answers are present on the screen, and that the reads stay
// scoped to the client server-side rather than being filtered in the browser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  LINKED_CONVERSATION_ID,
  PROJECT_ID,
  renderWithSession,
  SESSION_ID,
  VLADIMIR_ARTIST_ID,
} from './fixtures';

// Pinned so "upcoming" and "overdue" mean the same thing on every run. The
// shared appointment fixture is dated 2026-09-01 and the follow-up 2026-07-05.
const NOW = new Date('2026-08-30T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('client workspace', () => {
  it('answers the next-booking, deposit and last-message questions without leaving the client', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    await screen.findByText('Fixture Client');

    // "When is the next appointment?" — the fixture appointment is proposed, so
    // its unconfirmed state has to be visible, not just its date.
    const nextBooking = screen.getByText('Next booking').closest('div') as HTMLElement;
    expect(within(nextBooking).getByRole('link')).toHaveAttribute('href', `#/appointments/${SESSION_ID}`);
    expect(within(nextBooking).getByText('proposed')).toBeInTheDocument();

    // "Has the deposit been paid?" — answered by state, and linked to where it
    // is settled.
    const deposit = screen.getByText('Deposit').closest('div') as HTMLElement;
    expect(within(deposit).getByText('requested')).toBeInTheDocument();
    expect(within(deposit).getByRole('link')).toHaveAttribute('href', `#/projects/${PROJECT_ID}`);

    // "When did we last speak?" — the client's own conversation, on whichever
    // channel it arrived.
    const lastMessage = screen.getByText('Last message').closest('div') as HTMLElement;
    expect(within(lastMessage).getByText('WhatsApp')).toBeInTheDocument();
    expect(within(lastMessage).getByRole('link')).toHaveAttribute('href', `#/inbox/${LINKED_CONVERSATION_ID}`);
  });

  it('recommends one next action rather than a row of equal options', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    await screen.findByText('Fixture Client');

    // The fixture follow-up is overdue and no conversation is awaiting a reply,
    // so the follow-up is what the operator is sent to.
    const action = await screen.findByRole('link', { name: 'Open the overdue follow-up' });
    expect(action).toHaveAttribute('href', '#/enquiries/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(screen.getByText('Something you promised is past its date.')).toBeInTheDocument();
  });

  it('shows the work, the bookings and the last messages on the same screen', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    await screen.findByText('Fixture Client');

    // The project the enquiry became, not both — the operator wants one job.
    const work = screen.getByRole('heading', { name: 'What they want' }).closest('section') as HTMLElement;
    expect(within(work).getByText('Raven sleeve')).toBeInTheDocument();
    expect(within(work).queryByText('ENQ-2026-0001')).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Bookings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();

    // The last thing actually said, inline.
    expect(screen.getByText('Do you do cover ups?')).toBeInTheDocument();
  });

  it('keeps contact details available but out of the way', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    await screen.findByText('Fixture Client');

    const details = screen.getByText('Contact details').closest('details') as HTMLElement;
    expect(details).not.toBeNull();
    expect(details.hasAttribute('open')).toBe(false);
    expect(within(details).getByText('fixture@example.test')).toBeInTheDocument();
  });

  it('scopes every workspace read to this client in the query, not in the browser', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}`, queryCalls });

    await screen.findByText('Fixture Client');

    const scopedTo = (table: string) => queryCalls.some(
      (call) => call.table === table
        && call.method === 'eq'
        && call.args[0] === 'client_id'
        && call.args[1] === CLIENT_ID
    );

    expect(scopedTo('sessions')).toBe(true);
    expect(scopedTo('follow_ups')).toBe(true);
    expect(scopedTo('communication_conversations')).toBe(true);
  });

  it('asks for nothing a read-only role cannot have', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, { role: 'read_only', path: `/clients/${CLIENT_ID}`, queryCalls });

    await screen.findByText('Fixture Client');

    // read_only holds viewSessions, viewEnquiries and viewFollowUps but not
    // viewNotes, so the internal-note read is never attempted.
    expect(queryCalls.some((call) => call.table === 'internal_notes')).toBe(false);
    expect(queryCalls.some((call) => call.table === 'sessions')).toBe(true);
    expect(queryCalls.some((call) => call.table === 'follow_ups')).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Notes' })).not.toBeInTheDocument();
  });

  it('shows the artist a shared client belongs to on every piece of their work', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    await screen.findByText('Fixture Client');
    expect(await screen.findAllByLabelText('Artist: Vladimir Vishar')).not.toHaveLength(0);
    expect(VLADIMIR_ARTIST_ID).toBeTruthy();
  });
});
