import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

function snapshot() {
  return {
    artist_id: VLADIMIR_ARTIST_ID,
    client_id: CLIENT_ID,
    subject: 'Is Friday still free?',
    last_message_at: '2026-09-01T10:00:00Z',
    direction: 'inbound',
    refreshed_at: '2026-09-01T10:01:00Z',
  };
}

describe('Today Gmail loading', () => {
  it('renders CRM-owned work even when the Gmail metadata snapshot is unavailable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network disabled in tests');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        failTable: 'gmail_client_metadata_snapshots',
        emailMessages: [],
      });

      expect(await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .toBeInTheDocument();
      expect(screen.queryByText('Is Friday still free?')).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('merges cached Gmail attention without any provider request', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network disabled in tests');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        gmailMetadataSnapshots: [snapshot()],
        emailMessages: [],
      });

      expect(await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .toBeInTheDocument();
      await waitFor(() => {
        expect(document.querySelector(`a[href="#/inbox/email/client-${CLIENT_ID}"]`)).not.toBeNull();
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
