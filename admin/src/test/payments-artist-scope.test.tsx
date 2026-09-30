// Payments cold start.
//
// Two defects made this screen unusable from a fresh session. The route was
// classified as a global section, so AppShell rendered an explanatory notice
// where the artist selector belongs; and PaymentsPage refuses to render without
// a selected artist. Together they asked the operator to choose an artist on a
// screen that offered no way to choose one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { PaymentsPage, inferPaymentsArtist } from '../pages/PaymentsPage';
import { ArtistScopeProvider, ARTIST_SCOPE_STORAGE_KEY } from '../lib/artist-scope';
import {
  KRISTINA_ARTIST_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('payments artist scope', () => {
  it('offers the artist selector on /payments instead of a global-section notice', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/payments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
    });

    expect(await screen.findByRole('combobox', { name: 'Artist' })).toBeInTheDocument();
    expect(screen.queryByText('This section covers every artist.')).not.toBeInTheDocument();
  });

  it('opens on one artist when several are reachable, and switches from the page', async () => {
    renderWithSession(<ArtistScopeProvider><PaymentsPage /></ArtistScopeProvider>, {
      role: 'owner',
      path: '/payments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
    });

    // No empty chooser: the page renders straight away for the first artist,
    // because the owner's memberships do not single one out.
    expect(await screen.findByRole('heading', { name: 'Create a new deposit for an individual session' })).toBeInTheDocument();
    expect(screen.queryByText('Choose one artist to manage payments.')).not.toBeInTheDocument();
    const switcher = screen.getByRole('group', { name: 'Payments for' });
    expect(within(switcher).getByRole('button', { name: 'Vladimir Vishar' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(switcher).getByRole('button', { name: 'Kristina Vishar' })).toHaveAttribute('aria-pressed', 'false');
    // Inference alone leaves the shared scope untouched.
    expect(window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY)).toBeNull();

    fireEvent.click(within(switcher).getByRole('button', { name: 'Kristina Vishar' }));
    await waitFor(() => {
      expect(window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY)).toBe(KRISTINA_ARTIST_ID);
    });
    // Once the operator has chosen, the header selector says who it is.
    expect(screen.queryByRole('group', { name: 'Payments for' })).not.toBeInTheDocument();
  });

  it('infers the only reachable artist rather than blocking on a choice of one', async () => {
    renderWithSession(<ArtistScopeProvider><PaymentsPage /></ArtistScopeProvider>, {
      role: 'owner',
      path: '/payments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
    });

    expect(await screen.findByRole('heading', { name: 'Create a new deposit for an individual session' })).toBeInTheDocument();
    expect(screen.queryByText('Choose one artist to manage payments.')).not.toBeInTheDocument();
    // Inference is local to this screen: the shared scope stays unset.
    expect(window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY)).toBeNull();
  });
});

describe('inferPaymentsArtist', () => {
  const artists = [{ id: 'a' }, { id: 'b' }];
  const member = (artist_id: string, access_level: string, profile_id = 'me') => ({ profile_id, artist_id, access_level, is_active: true });

  it('prefers the one artist the operator is', () => {
    expect(inferPaymentsArtist(artists, [member('a', 'owner'), member('b', 'artist')], 'me')).toBe('b');
  });

  it('falls back to a single owner membership, then to the first artist', () => {
    expect(inferPaymentsArtist(artists, [member('b', 'owner'), member('a', 'manager')], 'me')).toBe('b');
    expect(inferPaymentsArtist(artists, [member('a', 'owner'), member('b', 'owner')], 'me')).toBe('a');
    expect(inferPaymentsArtist(artists, [member('b', 'artist', 'someone-else')], 'me')).toBe('a');
  });

  it('returns null only with no artist at all', () => {
    expect(inferPaymentsArtist([], [], 'me')).toBeNull();
  });
});
