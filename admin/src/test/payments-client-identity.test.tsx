// Payment rows must name a person.
//
// Deposit requests and grouped-session selection identified an appointment by
// its start time alone, and the grouped list printed the first eight
// characters of a project UUID beside it. Two clients on the same day were
// therefore indistinguishable at the moment money is requested, and a database
// identifier stood in for the one fact the operator needs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { PaymentsPage } from '../pages/PaymentsPage';
import { ArtistScopeProvider } from '../lib/artist-scope';
import { CLIENT_ID, PROJECT_ID, SESSION, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

// A second eligible appointment for the same client and project: grouped
// deposit selection only renders with two or more, and that list is where a
// raw project identifier used to stand in for the client.
const SECOND_SESSION = {
  ...SESSION,
  id: '66666666-6666-4666-8666-666666666666',
  client_id: CLIENT_ID,
  start_at: '2026-09-08T10:00:00Z',
  end_at: '2026-09-08T16:00:00Z',
};

// The shared appointment fixture is dated 2026-09-01, and the deposit screens
// deliberately only offer appointments that have not finished yet. Without a
// pinned clock these assertions quietly stopped holding once real time passed
// that afternoon - a test that expires rather than one that fails for a
// reason. Pinned the same way today-page and client-identity-in-lists pin it.
const NOW = new Date('2026-09-01T08:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

async function renderPayments() {
  const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
  renderWithSession(<ArtistScopeProvider><PaymentsPage /></ArtistScopeProvider>, {
    role: 'owner',
    path: '/payments',
    accessibleArtistIds: [VLADIMIR_ARTIST_ID],
    extraSessions: [SECOND_SESSION],
    queryCalls,
  });
  // The heading renders before the appointments resolve, so settle on the
  // loaded rows rather than the panel that will hold them.
  await screen.findAllByText('Fixture Client');
  return queryCalls;
}

describe('payment row identity', () => {
  it('names the client on a deposit request row', async () => {
    await renderPayments();

    const heading = screen.getByRole('heading', {
      name: 'Create a new deposit for an individual session',
    });
    const panel = heading.closest('section') as HTMLElement;

    const rows = within(panel).getAllByText('Fixture Client');
    expect(rows).toHaveLength(2);
    // The date survives as supporting detail rather than the row's identity.
    expect(panel.textContent).toContain('01/09/2026');
  });

  it('names the client when selecting sessions for a combined deposit', async () => {
    await renderPayments();

    // Multi-session deposits are deliberately progressive disclosure now: it
    // is a valid but occasional operation, so daily work should not pay its
    // vertical cost until the operator asks for it.
    fireEvent.click(screen.getByText('One deposit for several sessions'));

    const checkboxes = screen.getAllByRole('checkbox', {
      name: /Select session Fixture Client/,
    });
    expect(checkboxes).toHaveLength(2);
  });

  it('never shows a raw record identifier beside a payment', async () => {
    await renderPayments();

    // The grouped list printed project_id.slice(0, 8). Assert the fragment is
    // gone rather than merely that a name is present.
    expect(screen.queryByText(new RegExp(PROJECT_ID.slice(0, 8)))).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PROJECT_ID.slice(0, 8));
  });

  it('resolves client names by id rather than the 200 most recent clients', async () => {
    const queryCalls = await renderPayments();

    const clientLookup = queryCalls.find(
      (call) => call.table === 'clients' && call.method === 'in'
    );
    expect(clientLookup).toBeDefined();
    expect(clientLookup?.args[0]).toBe('id');
  });
});
