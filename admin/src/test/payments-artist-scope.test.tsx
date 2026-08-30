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
import { PaymentsPage } from '../pages/PaymentsPage';
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
    expect(screen.queryByText('Global section')).not.toBeInTheDocument();
  });

  it('lets a cold start choose an artist inline when more than one is reachable', async () => {
    renderWithSession(<ArtistScopeProvider><PaymentsPage /></ArtistScopeProvider>, {
      role: 'owner',
      path: '/payments',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
    });

    // Await the settled render: the scope provider resolves its artist list
    // asynchronously and replaces the nodes captured before it does.
    const chooser = await screen.findByRole('group', {
      name: 'Choose one artist to manage payments.',
    });
    expect(within(chooser).getByRole('button', { name: 'Vladimir Vishar' })).toBeInTheDocument();
    expect(within(chooser).getByRole('button', { name: 'Kristina Vishar' })).toBeInTheDocument();

    fireEvent.click(within(chooser).getByRole('button', { name: 'Vladimir Vishar' }));

    await waitFor(() => {
      expect(screen.queryByText('Choose one artist to manage payments.')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY)).toBe(VLADIMIR_ARTIST_ID);
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
