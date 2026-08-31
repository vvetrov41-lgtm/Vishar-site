// Email inside the unified Inbox.
//
// Email joins the same work queue without pretending to be a messaging channel.
// The Inbox itself is driven by stored CRM delivery state; live Gmail history is
// fetched only when the operator opens one linked email conversation.

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
const FAILED_ID = 'd2222222-2222-4222-8222-222222222222';
const SENT_ID = 'd3333333-3333-4333-8333-333333333333';

function email(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    status: 'draft',
    to_email: 'diana@example.com',
    subject: 'Your deposit for the raven sleeve',
    body: 'Hi Diana, here is the deposit link for your first session.',
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

describe('email in the inbox list', () => {
  it('puts an unapproved draft in the same queue as an unanswered message', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      emailMessages: [email()],
    });

    // The messaging conversation and the email thread are both present, each
    // labelled with the channel it actually came from.
    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.getByText('Your deposit for the raven sleeve')).toBeInTheDocument();
    expect(screen.getAllByText('Email').length).toBeGreaterThan(0);
    expect(screen.getByText('Draft to approve')).toBeInTheDocument();
  });

  it('names the client rather than the address when the CRM knows them', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/inbox', emailMessages: [email()] });
    await screen.findByText('Your deposit for the raven sleeve');
    expect(screen.getAllByText('Fixture Client').length).toBeGreaterThan(0);
  });

  it('keeps an address the CRM has never seen out of the working queue', async () => {
    // The same boundary as messaging, applied to the other family. An email
    // with neither a client nor an enquiry has not reached a CRM record, so it
    // is not a job the operator is behind on.
    //
    // The CRM writes its own drafts against a client or an enquiry, so this
    // costs no real outbound work; what it excludes is mail that arrived
    // without context.
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      emailMessages: [
        email(),
        email({
          id: FAILED_ID,
          client_id: null,
          enquiry_id: null,
          project_id: null,
          to_email: 'stranger@example.com',
          subject: 'Unrecognised correspondence',
        }),
      ],
    });
    await screen.findByText('Your deposit for the raven sleeve');
    expect(screen.queryByText('stranger@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('Unrecognised correspondence')).not.toBeInTheDocument();
  });

  it('never labels an email as a reply the client is waiting on', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      emailMessages: [email()],
    });
    const row = (await screen.findByText('Your deposit for the raven sleeve')).closest('a');
    expect(row).not.toBeNull();
    // Inbox prioritisation is based on CRM delivery state. Live Gmail is loaded
    // only in the conversation detail, so the list never guesses direction.
    expect(within(row as HTMLElement).queryByText('Needs reply')).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Draft to approve')).toBeInTheDocument();
  });

  it('shows both families together under Needs reply, and only those waiting', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      emailMessages: [
        email(),
        email({
          id: SENT_ID,
          status: 'sent',
          sent_at: '2026-07-01T10:00:00Z',
          client_id: null,
          enquiry_id: null,
          project_id: null,
          to_email: 'done@example.com',
          subject: 'Your appointment is confirmed',
        }),
      ],
    });
    await screen.findByText('Your deposit for the raven sleeve');

    fireEvent.click(screen.getByRole('button', { name: 'Needs reply' }));

    await waitFor(() => expect(screen.queryByText('Thanks, see you then')).not.toBeInTheDocument());
    // The unanswered Instagram thread and the unapproved draft, together.
    expect(screen.getByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.getByText('Your deposit for the raven sleeve')).toBeInTheDocument();
    // A sent email is finished work and drops out.
    expect(screen.queryByText('Your appointment is confirmed')).not.toBeInTheDocument();
  });

  it('filters to email alone without losing the messaging channels from the tabs', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/inbox', emailMessages: [email()] });
    await screen.findByText('Can we move Friday?');

    fireEvent.click(screen.getByRole('tab', { name: 'Email' }));
    await waitFor(() => expect(screen.queryByText('Can we move Friday?')).not.toBeInTheDocument());
    expect(screen.getByText('Your deposit for the raven sleeve')).toBeInTheDocument();
  });

  it('keeps the inbox usable when email cannot be read at all', async () => {
    // A revoked Gmail integration, a policy change or an outage must not take
    // the messaging queue down with it.
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      failTable: 'email_messages',
    });

    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.getByText('Email conversations could not be loaded.')).toBeInTheDocument();
  });

  it('scopes email to the selected artist like every other row', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/inbox',
      accessibleArtistIds: [VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID],
      emailMessages: [email({ artist_id: KRISTINA_ARTIST_ID, to_email: 'kristina-client@example.com', client_id: null, enquiry_id: null })],
    });
    await screen.findByText('Can we move Friday?');

    const scope = await screen.findByRole('combobox', { name: 'Artist' });
    fireEvent.change(scope, { target: { value: VLADIMIR_ARTIST_ID } });

    await waitFor(() => {
      expect(screen.queryByText('kristina-client@example.com')).not.toBeInTheDocument();
    });
  });
});

describe('an email conversation', () => {
  it('keeps the client, enquiry and project context on screen', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/inbox/email/enquiry-${ENQUIRY_ID}`,
      emailMessages: [email()],
    });

    expect(await screen.findByRole('heading', { name: 'Your deposit for the raven sleeve' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open client' })).toHaveAttribute('href', `#/clients/${CLIENT_ID}`);
    expect(screen.getAllByRole('link', { name: 'Open enquiry' })[0]).toHaveAttribute('href', `#/enquiries/${ENQUIRY_ID}`);
    expect(screen.getByRole('link', { name: 'Open project' })).toHaveAttribute('href', `#/projects/${PROJECT_ID}`);
  });

  it('offers approval rather than a composer, and says the words go to the client', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/inbox/email/enquiry-${ENQUIRY_ID}`,
      emailMessages: [email()],
    });

    expect(await screen.findByText('Waiting for your approval')).toBeInTheDocument();
    expect(screen.getByText('Hi Diana, here is the deposit link for your first session.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeInTheDocument();
    // The CRM has no direct-send path, so this screen must not grow one.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('approves through the audited RPC, once the operator agrees', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      role: 'owner',
      path: `/inbox/email/enquiry-${ENQUIRY_ID}`,
      emailMessages: [email()],
      rpcCalls,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve and send' }));
    // Sending words to a client is consequential, so it goes through the same
    // dialog every other consequential action uses.
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and send' }));

    await waitFor(() => {
      expect(rpcCalls).toContainEqual({
        name: 'approve_email_draft',
        args: { p_email_message_id: DRAFT_ID },
      });
    });
  });

  it('explains a failed send instead of offering approval again', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/inbox/email/enquiry-${ENQUIRY_ID}`,
      emailMessages: [email({
        id: FAILED_ID,
        status: 'failed',
        failed_at: '2026-07-01T09:30:00Z',
        error_code: 'gmail_oauth_expired',
      })],
    });

    const failed = await screen.findByText('This did not send');
    const page = failed.closest('.card, section') ?? document.body;
    expect(within(page as HTMLElement).queryByRole('button', { name: 'Approve and send' }))
      .not.toBeInTheDocument();
    // The raw provider code stays out of the operator's way, as it does on the
    // calendar row.
    expect(screen.queryByText(/gmail_oauth_expired/)).not.toBeInTheDocument();
  });

  it('tells a booking manager the approval is not theirs, rather than failing on press', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/email/enquiry-${ENQUIRY_ID}`,
      emailMessages: [email()],
    });

    const notice = await screen.findByText('Only the studio owner can approve an email for sending.');
    const page = notice.closest('.card, section') ?? document.body;
    expect(within(page as HTMLElement).queryByRole('button', { name: 'Approve and send' }))
      .not.toBeInTheDocument();
  });

  it('is reachable from the enquiry without duplicating the approval there', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/enquiries/${ENQUIRY_ID}`,
      emailMessages: [email()],
    });

    const open = await screen.findByRole('link', { name: 'Open email conversation' });
    expect(open).toHaveAttribute('href', `#/inbox/email/enquiry-${ENQUIRY_ID}`);
    // The enquiry says email exists and points at it. Approving happens in one
    // place, so there is never a second copy of the same draft to act on.
    expect(screen.queryByRole('button', { name: 'Approve and send' })).not.toBeInTheDocument();
    expect(screen.getByText('Draft to approve')).toBeInTheDocument();
  });

  it('shows live Gmail replies inside the CRM while keeping sending read-only', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      enquiry_id: ENQUIRY_ID,
      threads: [{
        thread_context_id: '96340000-0000-4000-8000-000000000001',
        subject: 'Your deposit for the raven sleeve',
        message_count: 1,
        messages: [{
          from: 'diana@example.com',
          to: 'studio@example.test',
          subject: 'Your deposit for the raven sleeve',
          timestamp: '2026-08-31T10:00:00.000Z',
          body: 'Thanks, I have received the deposit link.',
          direction: 'inbound',
          untrusted_content: true,
        }],
        untrusted_content: true,
      }],
      untrusted_content: true,
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: `/inbox/email/enquiry-${ENQUIRY_ID}`,
        emailMessages: [email()],
      });

      expect(await screen.findByText('Live Gmail conversation')).toBeInTheDocument();
      expect(await screen.findByText('Thanks, I have received the deposit link.')).toBeInTheDocument();
      expect(screen.getByText('Incoming')).toBeInTheDocument();
      expect(screen.getByText('CRM delivery history')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('finds the mailbox for a thread that names a client but no enquiry', async () => {
    // This is the shape every stored email in production actually has: a
    // deposit receipt written against the client, with no enquiry on it. The
    // gateway can only be addressed by enquiry, so those threads showed no
    // mailbox history at all - which is why Gmail correspondence appeared to
    // exist nowhere in the CRM.
    //
    // The client's own enquiries are the deterministic link the CRM already
    // holds. Nothing here matches on the email address.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/v1/operator/enquiries/${ENQUIRY_ID}/gmail/history`);
      return Response.json({
        enquiry_id: ENQUIRY_ID,
        threads: [{
          thread_context_id: 'c9990000-0000-4000-8000-000000000001',
          subject: 'Raven sleeve',
          message_count: 1,
          messages: [{
            from: 'diana@example.com',
            to: 'studio@example.test',
            subject: 'Raven sleeve',
            timestamp: '2026-08-31T10:00:00.000Z',
            body: 'Is Friday still free?',
            direction: 'inbound',
            untrusted_content: true,
          }],
          untrusted_content: true,
        }],
        untrusted_content: true,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: `/inbox/email/client-${CLIENT_ID}`,
        emailMessages: [email({ enquiry_id: null })],
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(await screen.findByText('Is Friday still free?')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
