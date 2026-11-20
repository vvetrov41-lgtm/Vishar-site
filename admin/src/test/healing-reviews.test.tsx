import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { App } from '../App';
import { CLIENT_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';
import { clearTodayCache } from '../lib/today-resource';
import { classifyReviewError } from '../lib/review-requests-api';

const ANCHOR = '0e000000-0000-4000-8000-000000000001';
const REQUEST = '0e000000-0000-4000-8000-000000000002';
const CONVERSATION = '0e000000-0000-4000-8000-000000000003';

type Args = Record<string, unknown> | undefined;

function suggestion() {
  return {
    client_id: CLIENT_ID, client_name: 'Alice Healing', anchor_session_id: ANCHOR,
    project_id: 'p1', project_title: 'Forearm peonies', last_session_at: '2026-08-01T10:00:00Z',
    days_since: 31, work_result: 'work_complete', preferred_contact: 'whatsapp',
    draft_message: 'Hi Alice, I hope all is well with you. How has your tattoo healed?',
  };
}

function replied(overrides: Record<string, unknown> = {}) {
  return {
    review_request_id: REQUEST, client_id: CLIENT_ID, client_name: 'Ben Replied', anchor_session_id: ANCHOR,
    healing_asked_at: '2026-08-25T10:00:00Z', healing_message_status: 'delivered', conversation_id: CONVERSATION,
    status: 'replied', replied_at: '2026-08-26T09:00:00Z', reply_message_id: 'm1',
    reply_text: 'Healed perfectly, thank you!', reply_attachment_count: 2,
    draft_message: 'So glad to hear it healed well! If you have a minute, a Google review would mean a lot to me: https://g.page/r/x/review',
    ...overrides,
  };
}

function lists(options: { suggestions?: unknown[]; items?: unknown[]; reviewUrl?: boolean } = {}) {
  const forVladimir = (args: Args) => args?.p_artist_id === VLADIMIR_ARTIST_ID;
  return {
    list_review_suggestions: (args: Args) => ({
      data: { artist_id: args?.p_artist_id, review_url_configured: options.reviewUrl ?? true,
        suggestions: forVladimir(args) ? options.suggestions ?? [] : [] },
      error: null,
    }),
    list_review_followups: (args: Args) => ({
      data: { artist_id: args?.p_artist_id, review_url_configured: options.reviewUrl ?? true,
        items: forVladimir(args) ? options.items ?? [] : [] },
      error: null,
    }),
  };
}

async function section(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: /Healing & reviews/ });
  return heading.closest('section') as HTMLElement;
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { clearTodayCache(); });

describe('Healing & reviews on Today', () => {
  it('sends the healing question only after the artist sees the text and presses Send', async () => {
    const sent: Args[] = [];
    let remaining = [suggestion()];
    renderWithSession(<App />, {
      role: 'owner', path: '/',
      rpcHandlers: {
        ...lists(),
        list_review_suggestions: (args: Args) => ({
          data: { artist_id: args?.p_artist_id, review_url_configured: true,
            suggestions: args?.p_artist_id === VLADIMIR_ARTIST_ID ? remaining : [] },
          error: null,
        }),
        send_healing_question: (args: Args) => {
          sent.push(args);
          remaining = [];
          return { data: { state: 'healing_asked' }, error: null };
        },
      },
    });

    const block = await section();
    expect(within(block).getByText('Alice Healing')).toBeVisible();
    expect(within(block).getByText(/Forearm peonies/)).toBeVisible();
    fireEvent.click(within(block).getByRole('button', { name: 'Ask' }));
    expect(within(block).getByText(/How has your tattoo healed\?/)).toBeVisible();
    expect(sent).toHaveLength(0);

    fireEvent.click(within(block).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ p_artist_id: VLADIMIR_ARTIST_ID, p_anchor_session_id: ANCHOR });
    expect(typeof sent[0]?.p_operation_id).toBe('string');
    expect(await within(block).findByText('Alice Healing: healing question sent.')).toBeVisible();
    expect(within(block).queryByRole('button', { name: 'Ask' })).toBeNull();
  });

  it('postpones for two weeks or stops suggesting the visit', async () => {
    const decisions: Args[] = [];
    renderWithSession(<App />, {
      role: 'owner', path: '/',
      rpcHandlers: {
        ...lists({ suggestions: [suggestion()] }),
        act_on_review_suggestion: (args: Args) => { decisions.push(args); return { data: {}, error: null }; },
      },
    });

    const block = await section();
    fireEvent.click(within(block).getByRole('button', { name: 'In 2 weeks' }));
    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toMatchObject({ p_action: 'snooze', p_snooze_days: 14, p_anchor_session_id: ANCHOR });

    fireEvent.click(await within(block).findByRole('button', { name: "Don't ask" }));
    await waitFor(() => expect(decisions).toHaveLength(2));
    expect(decisions[1]).toMatchObject({ p_action: 'dismiss' });
    expect(decisions[1]?.p_operation_id).not.toBe(decisions[0]?.p_operation_id);
  });

  it('shows the reply and sends the review request text the artist edited', async () => {
    const asked: Args[] = [];
    renderWithSession(<App />, {
      role: 'owner', path: '/',
      rpcHandlers: {
        ...lists({ items: [replied()] }),
        ask_for_review: (args: Args) => { asked.push(args); return { data: {}, error: null }; },
      },
    });

    const block = await section();
    expect(within(block).getByText('Healed perfectly, thank you!')).toBeVisible();
    expect(within(block).getByText(/attachments: 2/)).toBeVisible();
    expect(within(block).getByRole('link', { name: 'Open conversation' })).toHaveAttribute('href', `#/inbox/${CONVERSATION}`);

    fireEvent.click(within(block).getByRole('button', { name: 'Ask for a review' }));
    const text = within(block).getByLabelText(/Check the text/);
    expect((text as HTMLTextAreaElement).value).toMatch(/Google review would mean a lot/);
    fireEvent.change(text, { target: { value: '  Thank you Ben! A review would help: https://g.page/r/x/review  ' } });
    fireEvent.click(within(block).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatchObject({
      p_artist_id: VLADIMIR_ARTIST_ID, p_review_request_id: REQUEST,
      p_body: 'Thank you Ben! A review would help: https://g.page/r/x/review',
    });
    expect(await within(block).findByText('Ben Replied: review request sent.')).toBeVisible();
  });

  it('explains a closed WhatsApp window and keeps the card', async () => {
    renderWithSession(<App />, {
      role: 'owner', path: '/',
      rpcHandlers: {
        ...lists({ items: [replied()] }),
        ask_for_review: () => ({ data: null, error: { code: '23514', message: 'WhatsApp free-form window is closed for this client' } }),
      },
    });

    const block = await section();
    fireEvent.click(within(block).getByRole('button', { name: 'Ask for a review' }));
    fireEvent.click(within(block).getByRole('button', { name: 'Send' }));
    expect(await within(block).findByRole('alert')).toHaveTextContent(/24-hour window has closed/);
    expect(within(block).getByText('Healed perfectly, thank you!')).toBeVisible();
  });

  it('retries an unknown failure with the same operation id', async () => {
    const attempts: Args[] = [];
    renderWithSession(<App />, {
      role: 'owner', path: '/',
      rpcHandlers: {
        ...lists({ items: [replied()] }),
        close_review_request: (args: Args) => {
          attempts.push(args);
          return attempts.length === 1
            ? { data: null, error: { code: 'PGRST000', message: 'network' } }
            : { data: {}, error: null };
        },
      },
    });

    const block = await section();
    fireEvent.click(within(block).getByRole('button', { name: 'Close' }));
    await within(block).findByRole('alert');
    fireEvent.click(within(block).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]?.p_operation_id).toBe(attempts[0]?.p_operation_id);
  });

  it('disables the review request without a Google review link', async () => {
    renderWithSession(<App />, {
      role: 'owner', path: '/',
      rpcHandlers: lists({ items: [replied()], reviewUrl: false }),
    });

    const block = await section();
    expect(within(block).getByRole('button', { name: 'Ask for a review' })).toBeDisabled();
    expect(within(block).getByText('No Google review link is set for this artist.')).toBeVisible();
  });

  it('shows a waiting row and flags an undelivered question', async () => {
    renderWithSession(<App />, {
      role: 'owner', path: '/',
      rpcHandlers: lists({ items: [replied({ status: 'awaiting_reply', replied_at: null, reply_text: null,
        reply_attachment_count: 0, healing_message_status: 'failed' })] }),
    });

    const block = await section();
    expect(within(block).getByText(/waiting for a reply/)).toBeVisible();
    expect(within(block).getByText('not delivered')).toBeVisible();
    expect(within(block).queryByRole('button', { name: 'Ask for a review' })).toBeNull();
  });

  it('is absent for read-only accounts and when there is nothing to suggest', async () => {
    const view = renderWithSession(<App />, {
      role: 'read_only', path: '/', rpcHandlers: lists({ suggestions: [suggestion()] }),
    });
    await waitFor(() => expect(view.rpcCalls.some((call) => call.name === 'get_today_pulse')).toBe(true));
    expect(screen.queryByRole('heading', { name: /Healing & reviews/ })).toBeNull();
    expect(view.rpcCalls.some((call) => call.name === 'list_review_suggestions')).toBe(false);
  });
});

describe('classifyReviewError', () => {
  it('names the database refusals the section explains', () => {
    expect(classifyReviewError({ code: '55000', message: 'this visit is not a current healing suggestion' })).toBe('not_suggested');
    expect(classifyReviewError({ code: '55000', message: 'the healing question template is not approved for this artist' })).toBe('template_not_ready');
    expect(classifyReviewError({ code: '55000', message: 'client has no open WhatsApp conversation' })).toBe('no_whatsapp');
    expect(classifyReviewError({ code: '55000', message: 'no Google review link is set for this artist' })).toBe('no_review_link');
    expect(classifyReviewError({ code: '55000', message: 'this review request is already decided' })).toBe('already_decided');
    expect(classifyReviewError({ code: 'PGRST202', message: 'Could not find the function' })).toBe('unavailable');
    expect(classifyReviewError({ code: '42501', message: 'denied' })).toBe('permission');
  });
});
