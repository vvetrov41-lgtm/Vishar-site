import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import {
  collectClientArtistIds,
  resolveArtistNames,
} from '../lib/client-artist-relationships';
import {
  ARTISTS,
  CLIENT_ID,
  KRISTINA_ARTIST_ID,
  PROJECT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

describe('shared client artist relationships', () => {
  it('deduplicates artist relationships across enquiries and projects', () => {
    const relationships = collectClientArtistIds(
      [
        { client_id: CLIENT_ID, artist_id: VLADIMIR_ARTIST_ID },
        { client_id: CLIENT_ID, artist_id: KRISTINA_ARTIST_ID },
      ],
      [
        { client_id: CLIENT_ID, artist_id: VLADIMIR_ARTIST_ID },
        { client_id: PROJECT_ID, artist_id: KRISTINA_ARTIST_ID },
      ]
    );

    expect(relationships.get(CLIENT_ID)).toEqual([
      VLADIMIR_ARTIST_ID,
      KRISTINA_ARTIST_ID,
    ]);
    expect(relationships.get(PROJECT_ID)).toEqual([KRISTINA_ARTIST_ID]);
  });

  it('resolves names in the accessible artist order', () => {
    expect(resolveArtistNames(
      [KRISTINA_ARTIST_ID, VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
      ARTISTS
    )).toEqual(['Vladimir Vishar', 'Kristina Vishar']);
  });

  it('shows artist context on a shared client row without adding an artist filter', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/clients' });

    const clientName = await screen.findByText('Fixture Client');
    const row = clientName.closest('a');
    expect(row).not.toBeNull();
    expect(await within(row as HTMLElement).findByLabelText('Artist: Vladimir Vishar')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Artist' })).not.toBeInTheDocument();
  });

  it('shows the relationship summary and record artist on client details', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/clients/${CLIENT_ID}`,
    });

    await screen.findByText('Fixture Client');
    const artistLabels = await screen.findAllByLabelText('Artist: Vladimir Vishar');
    expect(artistLabels.length).toBeGreaterThanOrEqual(3);
  });
});
