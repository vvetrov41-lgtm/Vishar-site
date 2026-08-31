// The boundary between studio work and a stranger with the studio's number.
//
// A WhatsApp message from an unknown number used to arrive in production as a
// first-class job: top of the Inbox, inside Needs reply, on Today, labelled
// "Unknown sender", offered a client to create. Nobody in the studio owed that
// person anything, and the queue that said otherwise is the queue an operator
// learns to stop trusting.
//
// The rule now is one predicate - `isActionableConversation` - asked by every
// operator surface. These tests pin it at each of those surfaces rather than at
// the function, because the defect was never in the predicate: it was in each
// screen having its own idea of what belonged.
//
// Nothing is deleted to achieve it. The unknown conversation is still stored,
// still readable, still one deliberate click away under its own view.

import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  ENQUIRY_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const STRANGER_ID = 'ba000000-0000-4000-8000-000000000001';
const KNOWN_ID = 'ba000000-0000-4000-8000-000000000002';

/** An inbound conversation from somebody the CRM cannot name. */
function stranger(overrides: Record<string, unknown> = {}) {
  return {
    id: STRANGER_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    channel: 'whatsapp',
    link_state: 'unmatched',
    state: 'open',
    client_id: null,
    client_name: null,
    enquiry_id: null,
    external_username: '+447700900123',
    external_display_label: null,
    // Deliberately the newest thing in the studio and unread, so any surface
    // that ranks by recency or unread would put it first if it let it in.
    last_message_at: '2026-08-31T11:37:00Z',
    last_inbound_at: '2026-08-31T11:37:00Z',
    last_outbound_at: null,
    operator_read_at: null,
    has_unread: true,
    latest_preview: 'is this the tattoo place',
    latest_direction: 'inbound',
    latest_message_type: 'text',
    ...overrides,
  };
}

/** A conversation that has reached a client, waiting on a genuine reply. */
function known(overrides: Record<string, unknown> = {}) {
  return {
    id: KNOWN_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    channel: 'whatsapp',
    link_state: 'linked',
    state: 'open',
    client_id: CLIENT_ID,
    client_name: 'Fixture Client',
    enquiry_id: ENQUIRY_ID,
    external_username: null,
    external_display_label: null,
    last_message_at: '2026-08-30T09:00:00Z',
    last_inbound_at: '2026-08-30T09:00:00Z',
    last_outbound_at: '2026-08-29T09:00:00Z',
    operator_read_at: null,
    has_unread: true,
    latest_preview: 'Can we move Friday?',
    latest_direction: 'inbound',
    latest_message_type: 'text',
    ...overrides,
  };
}

describe('unknown senders are not studio work', () => {
  it('keeps an unknown WhatsApp sender out of the Inbox list', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [stranger(), known()],
    });

    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.queryByText('is this the tattoo place')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown sender')).not.toBeInTheDocument();
  });

  it('keeps an unknown sender out of Needs reply', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [stranger(), known()],
    });
    await screen.findByText('Can we move Friday?');

    fireEvent.click(screen.getByRole('button', { name: 'Needs reply' }));

    // The stranger spoke last and nobody has answered, so the raw
    // "client spoke last" rule would have admitted it here.
    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.queryByText('is this the tattoo place')).not.toBeInTheDocument();
  });

  it('keeps an unknown sender off Today', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/',
      conversations: [stranger(), known()],
    });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;

    expect(needsYou.querySelector(`a[href="#/inbox/${KNOWN_ID}"]`)).not.toBeNull();
    expect(needsYou.querySelector(`a[href="#/inbox/${STRANGER_ID}"]`)).toBeNull();
  });

  it('does not let an unknown sender inflate the waiting count', async () => {
    // Two strangers and one real conversation. If the boundary leaked, the
    // reply rows on Today would multiply with the noise.
    renderWithSession(<App />, {
      role: 'owner',
      path: '/',
      conversations: [
        stranger(),
        stranger({ id: 'ba000000-0000-4000-8000-000000000003', latest_preview: 'hello?' }),
        known(),
      ],
    });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;

    expect(within(needsYou).getAllByText('Waiting for your reply')).toHaveLength(1);
  });

  it('leaves a linked conversation exactly where it was', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [stranger(), known()],
    });

    const row = (await screen.findByText('Can we move Friday?')).closest('a') as HTMLElement;
    expect(row).toHaveAttribute('href', `#/inbox/${KNOWN_ID}`);
    expect(within(row).getByText('Fixture Client')).toBeInTheDocument();
    expect(within(row).getByText('Needs reply')).toBeInTheDocument();
  });

  it('applies the same rule to Instagram, because the path is shared', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [
        stranger({ channel: 'instagram', external_username: 'passer.by' }),
        known({ channel: 'instagram' }),
      ],
    });

    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.queryByText('is this the tattoo place')).not.toBeInTheDocument();
  });

  it('does not let archiving and restoring smuggle an unknown sender back in', async () => {
    // Archived and open are the same conversation to the CRM, so the boundary
    // has to hold on both sides of that switch. If it were expressed as
    // "hide archived rows" instead of "hide unlinked rows", un-archiving would
    // quietly readmit the stranger.
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [stranger({ state: 'archived' }), known()],
    });
    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.queryByText('is this the tattoo place')).not.toBeInTheDocument();

    cleanup();

    // Restored to open: still unlinked, so still not the operator's problem.
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [stranger({ state: 'open' }), known()],
    });
    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.queryByText('is this the tattoo place')).not.toBeInTheDocument();
  });

  it('offers no way to pull unknown senders into the work queue', async () => {
    // Not even as a tab. A filter that reveals a backlog is still a backlog the
    // operator feels responsible for, which is the thing being removed. The
    // rows remain in the database for webhook history and audit; this screen is
    // simply not where they live.
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [stranger(), known()],
    });
    await screen.findByText('Can we move Friday?');

    expect(screen.queryByRole('button', { name: 'Unknown senders' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unmatched' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Linked clients' })).not.toBeInTheDocument();
    expect(screen.queryByText('is this the tattoo place')).not.toBeInTheDocument();
    expect(screen.queryByText('Not linked')).not.toBeInTheDocument();
  });

  it('never asks the server for anything but linked conversations', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      conversations: [stranger(), known()],
    });
    await screen.findByText('Can we move Friday?');

    fireEvent.click(screen.getByRole('button', { name: 'Needs reply' }));
    fireEvent.click(screen.getByRole('tab', { name: 'WhatsApp' }));

    const listed = rpcCalls.filter((call) => call.name === 'list_communication_conversations');
    expect(listed.length).toBeGreaterThan(0);
    // Whatever the operator clicks, unmatched rows are never requested at all.
    for (const call of listed) {
      expect(call.args?.p_link_state).toBe('linked');
    }
  });
});
