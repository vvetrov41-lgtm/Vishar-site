// A known client emails for the first time.
//
// Until now the Inbox could only show email the CRM had already written. A
// client the studio knows could write in and appear nowhere: no stored message
// meant no thread, and no thread meant no row in the work queue. The operator's
// own mailbox knew; the CRM did not.
//
// Discovery closes that, and every test here is about the boundary it has to
// respect while doing so. The gateway resolves addresses to CRM clients
// server-side and returns only the ones it can name, so these tests assert what
// the SCREEN does with that answer: one row per client, the client's own name,
// no provider identifiers, and no route back in for a stranger.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  ENQUIRY_ID,
  KRISTINA_ARTIST_ID,
  PROJECT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const DRAFT_ID = 'd1111111-1111-4111-8111-111111111111';

/** What the discovery gateway answers for one artist. */
function discovery(artistId: string, clients: Record<string, unknown>[]) {
  return { artist_id: artistId, clients, untrusted_content: true };
}

function knownClient(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: 'Fixture Client',
    subject: 'Is Friday still free?',
    last_message_at: '2026-08-31T10:00:00Z',
    direction: 'inbound',
    untrusted_content: true,
    ...overrides,
  };
}

/**
 * Answer the discovery route per artist, and record what was asked.
 *
 * Anything else the page fetches fails, exactly as it does in the rest of the
 * suite, so a test cannot pass by reaching something it should not.
 */
function gateway(byArtist: Record<string, unknown>, calls: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const match = /^\/v1\/operator\/artists\/([0-9a-f-]{36})\/gmail\/inbox$/i.exec(url.pathname);
    if (match && byArtist[match[1]]) return Response.json(byArtist[match[1]]);
    throw new TypeError('network disabled in tests');
  });
}

function email(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    status: 'draft',
    to_email: 'fixture@example.test',
    subject: 'Your deposit for the raven sleeve',
    body: 'Hi, here is the deposit link.',
    created_by_kind: 'ai',
    created_at: '2026-07-01T09:00:00Z',
    client_id: CLIENT_ID,
    enquiry_id: ENQUIRY_ID,
    project_id: PROJECT_ID,
    approved_at: null,
    sent_at: null,
    failed_at: null,
    error_code: null,
    ...overrides,
  };
}

describe('a known client emails for the first time', () => {
  it('appears in the Inbox with no stored email at all', async () => {
    const fetchMock = gateway({ [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
      });

      expect(await screen.findByText('Is Friday still free?')).toBeInTheDocument();
      // Named, not addressed: the CRM knows who this is.
      expect(screen.getAllByText('Fixture Client').length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the client-scoped Gmail history that already exists', async () => {
    const fetchMock = gateway({ [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
      });

      const row = (await screen.findByText('Is Friday still free?')).closest('a');
      expect(row).toHaveAttribute('href', `#/inbox/email/client-${CLIENT_ID}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('counts as needing a reply, because the client genuinely spoke last', async () => {
    const fetchMock = gateway({ [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
      });
      await screen.findByText('Is Friday still free?');

      fireEvent.click(screen.getByRole('button', { name: 'Needs reply' }));
      expect(await screen.findByText('Is Friday still free?')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reaches Today, so the morning triage is not silent about it', async () => {
    const fetchMock = gateway({ [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
      });

      const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .closest('section') as HTMLElement;
      await waitFor(() => {
        expect(needsYou.querySelector(`a[href="#/inbox/email/client-${CLIENT_ID}"]`)).not.toBeNull();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not appear twice when the CRM has also written to that client', async () => {
    // The same person, reachable from two places: a stored CRM draft keyed by
    // ENQUIRY, and discovery which knows only the client. They are one
    // conversation and must be one row - otherwise the duplication the
    // client-scoped design prevents in the database reappears in the list.
    const fetchMock = gateway({ [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [email()],
      });

      await screen.findByText('Your deposit for the raven sleeve');
      const rows = screen.getAllByRole('link').filter(
        (link) => link.getAttribute('href')?.startsWith('#/inbox/email/'),
      );
      expect(rows).toHaveLength(1);
      // The stored row keeps its CRM context and destination.
      expect(rows[0]).toHaveAttribute('href', `#/inbox/email/enquiry-${ENQUIRY_ID}`);
      // And discovery still contributes the fact that the client replied.
      expect(within(rows[0]).getByText('Needs reply')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows one row for a client with several enquiries', async () => {
    // The gateway already collapses per client; this proves the screen does not
    // re-expand it once the CRM's own enquiry rows are in play.
    const fetchMock = gateway({ [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
        extraEnquiries: [
          { id: 'ee000000-0000-4000-8000-000000000001' },
          { id: 'ee000000-0000-4000-8000-000000000002' },
        ],
      });

      await screen.findByText('Is Friday still free?');
      expect(screen.getAllByText('Is Friday still free?')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('asks per artist, and only for artists the operator can reach', async () => {
    const calls: string[] = [];
    const fetchMock = gateway({
      [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]),
      [KRISTINA_ARTIST_ID]: discovery(KRISTINA_ARTIST_ID, []),
    }, calls);
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
        emailMessages: [],
      });
      await screen.findByText('Is Friday still free?');

      // Each artist is named explicitly. Nothing sweeps a mailbox the operator
      // was not scoped to.
      expect(calls).toContain(`/v1/operator/artists/${VLADIMIR_ARTIST_ID}/gmail/inbox`);
      expect(calls).toContain(`/v1/operator/artists/${KRISTINA_ARTIST_ID}/gmail/inbox`);
      expect(calls.every((path) => path.startsWith('/v1/operator/artists/'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('survives one artist mailbox being unreachable', async () => {
    // A revoked integration for one artist must not empty the queue for the
    // other, and must not take the messaging half of the screen with it.
    const fetchMock = gateway({ [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [knownClient()]) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
        emailMessages: [],
      });

      expect(await screen.findByText('Is Friday still free?')).toBeInTheDocument();
      expect(screen.getByText('Can we move Friday?')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders nothing that could be a provider identifier', async () => {
    // Discovery deliberately carries no message or thread id. If one were ever
    // added to the payload, it must not reach the page.
    const fetchMock = gateway({
      [VLADIMIR_ARTIST_ID]: discovery(VLADIMIR_ARTIST_ID, [
        { ...knownClient(), provider_thread_id: 'thread-should-not-render' },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
      });

      await screen.findByText('Is Friday still free?');
      expect(document.body.textContent).not.toContain('thread-should-not-render');
      expect(document.body.innerHTML).not.toContain('thread-should-not-render');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores a discovery payload that is not shaped as promised', async () => {
    // An unknown sender cannot arrive this way, because matching happens in the
    // database. But a malformed answer must degrade to "no Gmail" rather than
    // rendering whatever it was handed.
    const fetchMock = vi.fn(async () => Response.json({
      artist_id: VLADIMIR_ARTIST_ID,
      clients: [{ client_id: 'not-a-uuid', subject: 'Cheap backlinks' }],
      untrusted_content: true,
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
      });

      // The messaging half still renders; the malformed Gmail answer is dropped.
      expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
      expect(screen.queryByText('Cheap backlinks')).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
