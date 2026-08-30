// Payments, read as daily work rather than as a settings screen.
//
// Seven panels sat in one stack with the Monzo connection first, the payment
// link catalogue and the deposit policy in the middle, and the money that had
// actually arrived last. Confirming a payment the server had already matched
// took four interactions to agree with it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';
import { ARTIST_SCOPE_STORAGE_KEY } from '../lib/artist-scope';

const SUGGESTED_CANDIDATE = {
  id: 'cand-1111-4111-8111-111111111111',
  amount: 150,
  currency: 'GBP',
  occurred_at: '2026-08-28T18:00:00Z',
  status: 'candidate',
  confirmed: false,
  suggested_payment_request: {
    payment_request_id: 'req-1111-4111-8111-111111111111',
    client_name: 'Fixture Client',
    purpose: 'deposit',
    request_status: 'sent',
    amount: 150,
    outstanding_amount: 150,
    currency: 'GBP',
    session_start_at: '2026-09-01T10:00:00Z',
    session_end_at: '2026-09-01T16:00:00Z',
    is_suggested: true,
  },
  matched_payment_request: null,
  match_options: [
    {
      payment_request_id: 'req-1111-4111-8111-111111111111',
      client_name: 'Fixture Client',
      purpose: 'deposit',
      request_status: 'sent',
      amount: 150,
      outstanding_amount: 150,
      currency: 'GBP',
      session_start_at: '2026-09-01T10:00:00Z',
      session_end_at: '2026-09-01T16:00:00Z',
      is_suggested: true,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  // Payments is artist-scoped; a chosen artist is the normal state.
  window.localStorage.setItem(ARTIST_SCOPE_STORAGE_KEY, VLADIMIR_ARTIST_ID);
});

afterEach(() => {
  window.localStorage.clear();
});

describe('payments information architecture', () => {
  it('leads with money that has arrived, and keeps setup closed', async () => {
    const { container } = renderWithSession(<App />, { role: 'owner', path: '/payments' });

    const headings = await screen.findAllByRole('heading', { level: 2 });
    const titles = headings.map((heading) => heading.textContent ?? '');

    // The money question comes before the deposit worklist, and both come
    // before anything that is configured once and left alone.
    const reconciliation = titles.findIndex((title) => /Reconcile Monzo payment/.test(title));
    const connection = titles.findIndex((title) => /Monzo/.test(title) && !/Reconcile/.test(title));
    expect(reconciliation).toBeGreaterThanOrEqual(0);
    expect(connection === -1 || reconciliation < connection).toBe(true);

    const setup = container.querySelector('.payments-setup') as HTMLElement;
    expect(setup).not.toBeNull();
    expect(setup.hasAttribute('open')).toBe(false);
    expect(within(setup).getByText(/Connection, payment links and deposit policy/)).toBeInTheDocument();
  });

  it('offers one agreement with a match the server already made', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: '/payments',
      reconciliationCandidates: [SUGGESTED_CANDIDATE],
    });

    // One sentence naming the person and the session, then one button.
    expect(await screen.findByText(/looks like Fixture Client's deposit/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: /Confirm .* from Fixture Client/ });

    // The dropdown that was already correctly filled is behind "Match
    // something else" rather than in the way.
    expect(screen.queryByRole('combobox', { name: 'Deposit request' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Match something else' })).toBeInTheDocument();

    fireEvent.click(confirm);

    // Recording money against a client still asks once.
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm payment' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'match_monzo_reconciliation_candidate')).toBe(true);
      expect(rpcCalls.some((call) => call.name === 'confirm_monzo_reconciliation_candidate')).toBe(true);
    });

    const match = rpcCalls.find((call) => call.name === 'match_monzo_reconciliation_candidate');
    expect(match?.args?.p_payment_request_id).toBe('req-1111-4111-8111-111111111111');
  });

  it('still offers the manual matcher when asked for it', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/payments',
      reconciliationCandidates: [SUGGESTED_CANDIDATE],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Match something else' }));

    expect(await screen.findByRole('combobox', { name: 'Deposit request' })).toBeInTheDocument();
  });
});
