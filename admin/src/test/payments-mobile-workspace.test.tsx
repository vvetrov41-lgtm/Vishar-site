import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PaymentsPage } from '../pages/PaymentsPage';
import { ArtistScopeProvider } from '../lib/artist-scope';
import { SESSION, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

const NOW = new Date('2026-09-01T08:00:00Z');

function futureSession(index: number) {
  const day = String(index + 2).padStart(2, '0');
  return {
    ...SESSION,
    id: `77777777-7777-4777-8${String(index).padStart(3, '0')}-777777777777`,
    start_at: `2026-09-${day}T10:00:00Z`,
    end_at: `2026-09-${day}T16:00:00Z`,
  };
}

function confirmedCandidate(index: number) {
  return {
    id: `cand-${String(index).padStart(4, '0')}-4111-8111-111111111111`,
    amount: 250,
    currency: 'GBP',
    occurred_at: `2026-08-${String(28 - index).padStart(2, '0')}T18:00:00Z`,
    status: 'matched',
    confirmed: true,
    suggested_payment_request: null,
    matched_payment_request: null,
    match_options: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

function renderPayments(options: Record<string, unknown> = {}) {
  return renderWithSession(<ArtistScopeProvider><PaymentsPage /></ArtistScopeProvider>, {
    role: 'owner',
    path: '/payments',
    accessibleArtistIds: [VLADIMIR_ARTIST_ID],
    ...options,
  });
}

describe('mobile deposits workspace', () => {
  it('shows four upcoming sessions first and expands on demand', async () => {
    renderPayments({ extraSessions: Array.from({ length: 5 }, (_, index) => futureSession(index)) });

    const heading = await screen.findByRole('heading', { name: 'Create a new deposit for an individual session' });
    const panel = heading.closest('section') as HTMLElement;

    // The panel heading renders before the asynchronous appointment request
    // settles, so wait for the row batch instead of sampling the empty shell.
    await waitFor(() => {
      expect(panel.querySelectorAll('.payments-session-row')).toHaveLength(4);
    });
    const showAll = within(panel).getByRole('button', { name: 'Show all (6)' });
    fireEvent.click(showAll);
    expect(panel.querySelectorAll('.payments-session-row')).toHaveLength(6);
  });

  it('opens one compact action sheet instead of rendering two actions on every session', async () => {
    renderPayments();

    const create = await screen.findByRole('button', { name: /\+ Create £250/ });
    fireEvent.click(create);

    const dialog = await screen.findByRole('dialog', { name: 'New deposit' });
    expect(within(dialog).getByText('Fixture Client')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Queue new £250 session deposit email' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create new £250 session deposit' })).toBeInTheDocument();
  });

  it('keeps completed payment history to three rows until requested', async () => {
    renderPayments({ reconciliationCandidates: Array.from({ length: 5 }, (_, index) => confirmedCandidate(index)) });

    await screen.findByRole('heading', { name: 'Already received money? Reconcile Monzo payment' });
    expect(document.querySelectorAll('.payment-row-compact')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'All processed payments (5)' }));
    expect(document.querySelectorAll('.payment-row-compact')).toHaveLength(5);
  });

  it('keeps multi-session deposits and Monzo settings closed by default', async () => {
    renderPayments({ extraSessions: [futureSession(1)] });

    await screen.findByRole('heading', { name: 'Create a new deposit for an individual session' });

    const grouped = screen.getByText('One deposit for several sessions').closest('details');
    const settings = document.querySelector('.payments-setup-inline');
    expect(grouped).not.toBeNull();
    expect(settings).not.toBeNull();
    expect(grouped?.hasAttribute('open')).toBe(false);
    expect(settings?.hasAttribute('open')).toBe(false);
  });
});
