// Gmail attention/discovery is CRM-owned snapshot state.
//
// The browser must never scan Gmail just to render Inbox or Today. A background
// service resolves provider metadata to known CRM clients and stores only the
// bounded metadata snapshot in Supabase; these tests exercise that browser
// boundary directly.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  ENQUIRY_ID,
  PROJECT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const DRAFT_ID = 'd1111111-1111-4111-8111-111111111111';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    artist_id: VLADIMIR_ARTIST_ID,
    client_id: CLIENT_ID,
    subject: 'Is Friday still free?',
    last_message_at: '2026-08-31T10:00:00Z',
    direction: 'inbound',
    refreshed_at: '2026-08-31T10:01:00Z',
    ...overrides,
  };
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

describe('CRM-owned Gmail metadata snapshot', () => {
  it('shows a known client in Inbox without any Gmail HTTP discovery request', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network disabled in tests');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        emailMessages: [],
        gmailMetadataSnapshots: [snapshot()],
      });

      expect(await screen.findByText('Is Friday still free?')).toBeInTheDocument();
      expect(screen.getAllByText('Fixture Client').length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens client-scoped Gmail history only after the operator chooses the row', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
      emailMessages: [],
      gmailMetadataSnapshots: [snapshot()],
    });

    const row = (await screen.findByText('Is Friday still free?')).closest('a');
    expect(row).toHaveAttribute('href', `#/inbox/email/client-${CLIENT_ID}`);
  });

  it('counts inbound snapshot metadata as needing a reply', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
      emailMessages: [],
      gmailMetadataSnapshots: [snapshot()],
    });

    await screen.findByText('Is Friday still free?');
    fireEvent.click(screen.getByRole('button', { name: 'Needs reply' }));
    expect(await screen.findByText('Is Friday still free?')).toBeInTheDocument();
  });

  it('reaches Today without contacting Gmail', async () => {
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
      });

      const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .closest('section') as HTMLElement;
      await waitFor(() => {
        expect(needsYou.querySelector(`a[href="#/inbox/email/client-${CLIENT_ID}"]`)).not.toBeNull();
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not duplicate a client when stored CRM email already exists', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
      emailMessages: [email()],
      gmailMetadataSnapshots: [snapshot()],
    });

    await screen.findByText('Your deposit for the raven sleeve');
    const rows = screen.getAllByRole('link').filter(
      (link) => link.getAttribute('href')?.startsWith('#/inbox/email/'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('href', `#/inbox/email/enquiry-${ENQUIRY_ID}`);
    expect(within(rows[0]).getByText('Needs reply')).toBeInTheDocument();
  });

  it('reads the snapshot table directly and does not sweep provider routes', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network disabled in tests');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/inbox',
        accessibleArtistIds: [VLADIMIR_ARTIST_ID],
        queryCalls,
        gmailMetadataSnapshots: [snapshot()],
      });

      await screen.findByText('Is Friday still free?');
      expect(queryCalls.some((call) => call.table === 'gmail_client_metadata_snapshots')).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never renders provider identifiers even if an over-wide fixture row contains one', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
      gmailMetadataSnapshots: [snapshot({ provider_thread_id: 'thread-should-not-render' })],
    });

    await screen.findByText('Is Friday still free?');
    expect(document.body.textContent).not.toContain('thread-should-not-render');
    expect(document.body.innerHTML).not.toContain('thread-should-not-render');
  });

  it('keeps messaging usable when the local snapshot read fails', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID],
      failTable: 'gmail_client_metadata_snapshots',
      emailMessages: [],
    });

    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.queryByText('Is Friday still free?')).not.toBeInTheDocument();
  });
});
