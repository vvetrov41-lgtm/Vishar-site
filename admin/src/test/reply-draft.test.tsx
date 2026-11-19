// "Suggest reply" fills the composer with one draft and nothing else: the
// artist still edits and presses the existing review-then-send path.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { LINKED_CONVERSATION_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';
import { createReplyDraftApi, ReplyDraftError } from '../lib/reply-draft-api';
import type { CrmClient } from '../lib/api';

const DRAFT = 'Hey! I charge £140 per hour or £980 for a full day 🙌🏻';

function attention(notCrm: string | null = null) {
  return {
    conversation_id: LINKED_CONVERSATION_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    awaiting_reply_since: '2026-08-30T09:00:00Z',
    not_crm_at: notCrm,
    handled_outside_crm_at: null,
    needs_reply: true,
  };
}

/** The Worker as the browser sees it: preflight probe, then one draft call. */
function worker(enabled: boolean, draft: Response = Response.json({ ok: true, draft: DRAFT })) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (!enabled) throw new TypeError('blocked by CORS');
    if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
    return draft.clone();
  });
}

describe('Suggest reply', () => {
  it('fills the composer and never queues a message', async () => {
    const fetcher = worker(true);
    vi.stubGlobal('fetch', fetcher);
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${LINKED_CONVERSATION_ID}`,
      conversationAttention: attention(),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Write a reply…')).toHaveValue(DRAFT));
    expect(screen.getByText(/nothing is sent until you press Send/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check before sending' })).toBeInTheDocument();
    expect(rpcCalls.find((call) => call.name === 'queue_communication_message')).toBeUndefined();

    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('https://api.vishartattoo.com/crm/reply-draft');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ conversation_id: LINKED_CONVERSATION_ID });
  });

  it('is hidden while the Worker flag is off', async () => {
    vi.stubGlobal('fetch', worker(false));
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${LINKED_CONVERSATION_ID}`,
      conversationAttention: attention(),
    });
    await screen.findByPlaceholderText('Write a reply…');
    expect(screen.queryByRole('button', { name: 'Suggest reply' })).toBeNull();
  });

  it('is hidden in a personal (not CRM) conversation', async () => {
    vi.stubGlobal('fetch', worker(true));
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${LINKED_CONVERSATION_ID}`,
      conversationAttention: attention('2026-08-30T10:00:00Z'),
    });
    await screen.findByPlaceholderText('Write a reply…');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Suggest reply' })).toBeNull();
  });

  it('says the WhatsApp window is closed instead of drafting', async () => {
    vi.stubGlobal('fetch', worker(true, Response.json({ error: 'whatsapp_window_closed' }, { status: 409 })));
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${LINKED_CONVERSATION_ID}`,
      conversationAttention: attention(),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Suggest reply' }));
    expect(await screen.findByText(/24-hour window is closed/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Write a reply…')).toHaveValue('');
  });
});

describe('reply draft API', () => {
  const client = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } }, error: null }) },
  } as unknown as CrmClient;
  const id = 'd3260000-0000-4000-8000-00000000000a';

  it('rejects a malformed or oversized draft', async () => {
    for (const body of [{ ok: true, draft: '' }, { ok: true, draft: 'x'.repeat(801) }, { ok: false }, null]) {
      const api = createReplyDraftApi(client, vi.fn(async () => Response.json(body)) as unknown as typeof fetch);
      await expect(api.suggestReply(id)).rejects.toBeInstanceOf(ReplyDraftError);
    }
  });

  it('maps Worker refusals to their reasons', async () => {
    for (const [error, status, reason] of [
      ['nothing_to_answer', 422, 'nothing_to_answer'],
      ['access_denied', 403, 'access_denied'],
      ['draft_unavailable', 503, 'unavailable'],
      ['not_found', 404, 'unavailable'],
    ] as const) {
      const api = createReplyDraftApi(client, vi.fn(async () => Response.json({ error }, { status })) as unknown as typeof fetch);
      await expect(api.suggestReply(id)).rejects.toMatchObject({ reason });
    }
  });

  it('does not call the Worker for a bad conversation id', async () => {
    const fetcher = vi.fn();
    const api = createReplyDraftApi(client, fetcher as unknown as typeof fetch);
    await expect(api.suggestReply('nope')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
