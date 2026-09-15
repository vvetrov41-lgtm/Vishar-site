import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

describe('Today Gmail loading', () => {
  it('renders CRM-owned work before Gmail discovery resolves, then merges the reply', async () => {
    let resolveDiscovery: ((response: Response) => void) | null = null;
    const pendingDiscovery = new Promise<Response>((resolve) => {
      resolveDiscovery = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/operator/artists/${VLADIMIR_ARTIST_ID}/gmail/inbox`) {
        return pendingDiscovery;
      }
      throw new TypeError('network disabled in tests');
    });

    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
      });

      // The mailbox is deliberately still unresolved. The Today shell and its
      // CRM-owned work must nevertheless be usable instead of staying on the
      // global loading state.
      expect(await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .toBeInTheDocument();
      expect(screen.queryByText('Is Friday still free?')).not.toBeInTheDocument();

      resolveDiscovery?.(Response.json({
        artist_id: VLADIMIR_ARTIST_ID,
        clients: [{
          client_id: CLIENT_ID,
          client_name: 'Fixture Client',
          subject: 'Is Friday still free?',
          last_message_at: '2026-09-01T10:00:00Z',
          direction: 'inbound',
          untrusted_content: true,
        }],
        untrusted_content: true,
      }));

      await waitFor(() => {
        expect(document.querySelector(`a[href="#/inbox/email/client-${CLIENT_ID}"]`)).not.toBeNull();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
