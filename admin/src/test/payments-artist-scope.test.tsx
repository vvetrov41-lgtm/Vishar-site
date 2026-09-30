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
import { PAYMENTS_ARTIST_STORAGE_KEY, PaymentsPage, inferPaymentsArtist } from '../pages/PaymentsPage';
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

  it('asks a global owner which artist, then remembers the choice for next time', async () => {
    const first = renderWithSession(<ArtistScopeProvider><PaymentsPage /></ArtistScopeProvider>, {
      role: 'owner',
      path: '/payments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
    });

    // The owner holds an 'owner' membership for both artists, so nothing
    // names one of them: money operations must not open on an arbitrary one.
    const chooser = await screen.findByRole('group', { name: 'Choose one artist to manage payments.' });
    fireEvent.click(within(chooser).getByRole('button', { name: 'Kristina Vishar' }));
    await waitFor(() => {
      expect(window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY)).toBe(KRISTINA_ARTIST_ID);
    });
    expect(window.localStorage.getItem(PAYMENTS_ARTIST_STORAGE_KEY)).toBe(KRISTINA_ARTIST_ID);
    first.unmount();

    // Back on "All artists" later, Payments opens on the artist chosen here
    // and says so, with a switcher.
    window.localStorage.removeItem(ARTIST_SCOPE_STORAGE_KEY);
    renderWithSession(<ArtistScopeProvider><PaymentsPage /></ArtistScopeProvider>, {
      role: 'owner',
      path: '/payments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
    });
    const switcher = await screen.findByRole('group', { name: 'Payments for' });
    expect(within(switcher).getByRole('button', { name: 'Kristina Vishar' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Choose one artist to manage payments.')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY)).toBeNull();
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
    expect(inferPaymentsArtist(artists, [member('b', 'owner'), member('a', 'manager')], 'me')).toBe('b');
  });

  it('never picks by list order when every membership is the same', () => {
    expect(inferPaymentsArtist(artists, [member('a', 'owner'), member('b', 'owner')], 'me')).toBeNull();
    expect(inferPaymentsArtist(artists, [member('b', 'artist', 'someone-else')], 'me')).toBeNull();
  });

  it('uses the artist remembered in this browser while it is still reachable', () => {
    const owners = [member('a', 'owner'), member('b', 'owner')];
    expect(inferPaymentsArtist(artists, owners, 'me', 'b')).toBe('b');
    expect(inferPaymentsArtist(artists, owners, 'me', 'gone')).toBeNull();
  });

  it('opens on the only artist and returns null with none', () => {
    expect(inferPaymentsArtist([{ id: 'a' }], [], 'me')).toBe('a');
    expect(inferPaymentsArtist([], [], 'me')).toBeNull();
  });
});
