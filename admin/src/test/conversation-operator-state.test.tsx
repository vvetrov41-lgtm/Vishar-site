// The conversation screen says whether the studio is owed a reply and lets the
// operator mark it handled outside the CRM or personal - both reversible.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConversationOperatorState } from '../components/ConversationOperatorState';
import type { ConversationAttention } from '../lib/communications-api';

const CONVERSATION = 'd3260000-0000-4000-8000-00000000000a';
const ARTIST = 'a1111111-1111-4111-8111-111111111111';

function attention(overrides: Partial<ConversationAttention>): ConversationAttention {
  return {
    conversation_id: CONVERSATION,
    artist_id: ARTIST,
    awaiting_reply_since: '2026-10-04T09:00:00Z',
    not_crm_at: null,
    handled_outside_crm_at: null,
    needs_reply: true,
    ...overrides,
  };
}

describe('ConversationOperatorState', () => {
  it('marks a waiting conversation handled outside the CRM for the message it saw', async () => {
    const waiting = attention({});
    const api = {
      getConversationAttention: vi.fn()
        .mockResolvedValueOnce(waiting)
        .mockResolvedValueOnce(attention({ needs_reply: false, handled_outside_crm_at: '2026-10-04T10:00:00Z' })),
      setNotCrm: vi.fn(),
      setHandledOutsideCrm: vi.fn().mockResolvedValue({}),
    };
    render(<ConversationOperatorState conversationId={CONVERSATION} linked={false} mayAct api={api} language="ru" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Обработано вне CRM' }));
    await waitFor(() => expect(api.setHandledOutsideCrm).toHaveBeenCalledWith(waiting, true));
    expect(await screen.findByRole('button', { name: 'Отменить «обработано»' })).toBeTruthy();
    expect(screen.getByText(/Новое сообщение вернёт диалог в работу/)).toBeTruthy();
  });

  it('marks an unknown sender personal and can take it back', async () => {
    const api = {
      getConversationAttention: vi.fn()
        .mockResolvedValueOnce(attention({}))
        .mockResolvedValueOnce(attention({ needs_reply: false, not_crm_at: '2026-10-04T10:00:00Z' })),
      setNotCrm: vi.fn().mockResolvedValue({}),
      setHandledOutsideCrm: vi.fn(),
    };
    render(<ConversationOperatorState conversationId={CONVERSATION} linked={false} mayAct api={api} language="en" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Personal / not CRM' }));
    await waitFor(() => expect(api.setNotCrm).toHaveBeenCalledWith(CONVERSATION, true));
    expect(await screen.findByRole('button', { name: 'Not personal after all' })).toBeTruthy();
  });

  it('never offers the personal mark on a linked client conversation', async () => {
    const api = {
      getConversationAttention: vi.fn().mockResolvedValue(attention({ not_crm_at: '2026-10-01T10:00:00Z' })),
      setNotCrm: vi.fn(),
      setHandledOutsideCrm: vi.fn(),
    };
    render(<ConversationOperatorState conversationId={CONVERSATION} linked mayAct api={api} language="en" />);

    expect(await screen.findByText(/Waiting on the studio since/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Personal / not CRM' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Not personal after all' })).toBeNull();
  });

  it('a read-only operator sees the state but cannot change it', async () => {
    const api = {
      getConversationAttention: vi.fn().mockResolvedValue(attention({})),
      setNotCrm: vi.fn(),
      setHandledOutsideCrm: vi.fn(),
    };
    render(<ConversationOperatorState conversationId={CONVERSATION} linked={false} mayAct={false} api={api} language="en" />);
    expect(await screen.findByText(/Waiting on the studio since/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
