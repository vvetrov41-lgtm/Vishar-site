import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { groupEmailThreads } from '../lib/email-threads';
import type { EmailMessage } from '../lib/types';
import {
  CLIENT_ID,
  PROJECT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const FAILED_ID = 'f2222222-2222-4222-8222-222222222222';

function email(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: FAILED_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    status: 'failed',
    to_email: 'client@example.test',
    subject: 'Deposit for your tattoo booking',
    created_by_kind: 'system',
    created_at: '2026-08-31T12:00:00Z',
    client_id: CLIENT_ID,
    enquiry_id: null,
    project_id: PROJECT_ID,
    approved_at: '2026-08-31T12:00:00Z',
    sent_at: null,
    failed_at: '2026-08-31T12:01:00Z',
    error_code: 'provider_rejected',
    ...overrides,
  };
}

describe('failed email dismissal', () => {
  it('stops a dismissed old failure from masking a later sent email', () => {
    const [thread] = groupEmailThreads([
      email({
        id: 's3333333-3333-4333-8333-333333333333',
        status: 'sent',
        created_at: '2026-08-31T13:00:00Z',
        sent_at: '2026-08-31T13:01:00Z',
        failed_at: null,
        error_code: null,
      }),
      email({ status: 'cancelled' }),
    ]);

    expect(thread.state).toBe('sent');
    expect(thread.actionable_message_id).toBeNull();
  });

  it('closes the warning through the protected RPC after confirmation', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      role: 'owner',
      path: `/inbox/email/client-${CLIENT_ID}`,
      emailMessages: [email()],
      rpcCalls,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss warning' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss warning' }));

    await waitFor(() => {
      expect(rpcCalls).toContainEqual({
        name: 'dismiss_failed_email_message',
        args: { p_email_message_id: FAILED_ID },
      });
    });
  });
});
