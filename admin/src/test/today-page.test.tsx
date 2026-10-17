// Today, as an operator meets it after opening the CRM.
//
// The audit's charge against the old Dashboard was that it answered three of
// the eight morning questions and its visual anchor was three enquiry counters.
// These tests assert that the screen now leads with work, that every row names
// a person and opens where the work is done, and that no counter survived.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  CONVERSATION_ID,
  PROJECT_ID,
  SESSION_ID,
  SESSION,
  SECOND_CLIENT_ID,
  renderWithSession,
} from './fixtures';

// The morning of the fixture booking, so "today" is the same day on every run.
const NOW = new Date('2026-09-01T08:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('today workspace', () => {
  it('leads with work rather than counters', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });

    await screen.findByRole('heading', { level: 2, name: 'Needs you now' });

    // The three enquiry counters were the screen's visual anchor and are gone.
    expect(screen.queryByRole('heading', { level: 2, name: 'Enquiries' })).not.toBeInTheDocument();
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument();
  });

  it('surfaces an unanswered conversation and opens it', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());

    const reply = within(needsYou).getByText('Waiting for your reply').closest('a') as HTMLElement;
    expect(reply).toHaveAttribute('href', `#/clients/${SECOND_CLIENT_ID}`);
  });

  it('lets an operator remove a handled client item without changing its business record', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'owner', path: '/', rpcCalls });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());
    const replyRow = within(needsYou).getByText('Waiting for your reply').closest('.row') as HTMLElement;
    fireEvent.click(within(replyRow).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'acknowledge_attention_item')).toBe(true);
    });
    expect(rpcCalls.some((call) => call.name === 'transition_enquiry_status')).toBe(false);
    expect(rpcCalls.some((call) => call.name === 'update_project_deposit')).toBe(false);
  });

  it('does not put an unknown sender on the triage list', async () => {
    // The unmatched fixture conversation is inbound, unread and the newest
    // thing in the studio, so before the conversation boundary it was the top
    // row of Today - a job nobody actually owed.
    renderWithSession(<App />, { role: 'owner', path: '/' });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());

    expect(within(needsYou).queryByRole('link', { name: /Unknown sender/ })).not.toBeInTheDocument();
    expect(within(needsYou).getAllByText('Waiting for your reply')).toHaveLength(1);
    expect(
      within(needsYou).queryByRole('link', { name: new RegExp(CONVERSATION_ID) }),
    ).not.toBeInTheDocument();
    expect(needsYou.querySelector(`a[href="#/inbox/${CONVERSATION_ID}"]`)).toBeNull();
  });

  it('surfaces an unconfirmed booking, an outstanding deposit and an overdue follow-up', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());

    expect(within(needsYou).getByText('Booking not confirmed yet').closest('a'))
      .toHaveAttribute('href', `#/appointments/${SESSION_ID}`);
    expect(within(needsYou).getByText('Deposit outstanding on a booked session').closest('a'))
      .toHaveAttribute('href', `#/projects/${PROJECT_ID}`);
    expect(within(needsYou).getByText('Follow-up overdue').closest('a'))
      .toHaveAttribute('href', expect.stringContaining('#/enquiries/'));
  });

  it("names the client on today's schedule and links to the appointment", async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });

    const today = (await screen.findByRole('heading', { level: 2, name: 'Today' }))
      .closest('section') as HTMLElement;
    await within(today).findByText('Fixture Client');

    const row = within(today).getByText('Fixture Client').closest('a') as HTMLElement;
    expect(row).toHaveAttribute('href', `#/appointments/${SESSION.id}`);
    expect(row.querySelector('.title')?.textContent).toBe('Fixture Client');
    expect(CLIENT_ID).toBeTruthy();
  });

  it('says plainly when nothing needs the operator', async () => {
    // read_only holds no finance or integration-job capability and the fixture
    // conversation is unread, so this asserts the triage list still fills for a
    // reduced role rather than silently emptying.
    renderWithSession(<App />, { role: 'read_only', path: '/' });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());

    expect(within(needsYou).getByText('Waiting for your reply')).toBeInTheDocument();
    expect(within(needsYou).queryByText('Integration jobs failed')).not.toBeInTheDocument();
  });

  it('asks for finance rows only where the role could hold finance', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: '/', rpcCalls });

    await screen.findByRole('heading', { level: 2, name: 'Needs you now' });

    // booking_manager holds no can_manage_finance membership in the fixtures,
    // so the reconciliation RPC is never attempted.
    expect(rpcCalls.some((call) => call.name === 'list_monzo_reconciliation_candidates')).toBe(false);
  });

  it('resolves the artist list itself so the finance read survives a cold start', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'owner', path: '/', rpcCalls });

    await screen.findByRole('heading', { level: 2, name: 'Needs you now' });

    // No artist is selected on a cold start. The screen must still ask about
    // money rather than repeating the Payments deadlock in a new place.
    const financeCalls = rpcCalls.filter((call) => call.name === 'list_monzo_reconciliation_candidates');
    expect(financeCalls.length).toBeGreaterThan(0);
  });

  describe('server pulse', () => {
    const pulse = (enabled: boolean) => ({
      generated_at: '2026-09-01T08:00:00Z',
      enabled,
      items: [
        {
          key: 'conflict-c1-deposit_paid_without_booking', kind: 'conflict', section: 'conflicts',
          reason: 'deposit_paid_without_booking', artist_id: 'a1', client_id: CLIENT_ID,
          subject: 'Server Pulse Client', href: `/clients/${CLIENT_ID}`, at: null,
          detail: 'deposit_paid_without_booking', sla_state: 'ok',
          ai_suggestion: { id: 'n1', action_type: 'offer_dates', reason: 'Deposit is in.' },
          acknowledgement: null, urgent: false,
        },
        {
          key: 'unmatched-inbound', kind: 'unmatched_inbound', section: 'inbox',
          reason: 'unknown_sender_unanswered', artist_id: 'a1', client_id: null, subject: null,
          href: '/inbox?view=unmatched', at: '2026-09-01T07:00:00Z', detail: '2', sla_state: null,
          ai_suggestion: null, acknowledgement: null, urgent: false,
        },
        {
          key: 'x', kind: 'invented_kind', section: 'waiting_for_you', reason: 'x', artist_id: 'a1',
          client_id: null, subject: 'Should not render', href: null, at: null, detail: null,
          sla_state: null, ai_suggestion: null, acknowledgement: null, urgent: false,
        },
      ],
      artists: [{
        artist_id: 'a1', artist_name: 'Vladimir',
        changes: { new_enquiries: 3, inbound_messages: 7, sessions_booked: 1, payments_received: 2 },
        median_first_reply_hours: 4.5, enquiries_without_reply_30d: 1,
        sources: { gmail_snapshot: 'stale', gmail_refreshed_at: '2026-08-30T08:00:00Z' },
      }],
    });

    it('keeps the browser list while the pulse is switched off', async () => {
      renderWithSession(<App />, { role: 'owner', path: '/', todayPulse: pulse(false) });
      const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());
      expect(within(needsYou).getByText('Waiting for your reply')).toBeInTheDocument();
      expect(within(needsYou).queryByText('Server Pulse Client')).not.toBeInTheDocument();
    });

    it('renders the server items, labels AI as a suggestion and reports a stale source', async () => {
      renderWithSession(<App />, { role: 'owner', path: '/', todayPulse: pulse(true) });
      const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());
      await within(needsYou).findByText('Server Pulse Client');
      expect(within(needsYou).getByText('Deposit paid, no session booked')).toBeInTheDocument();
      expect(within(needsYou).getByText('AI suggestion: offer dates')).toBeInTheDocument();
      expect(within(needsYou).getByText('Messages from unknown senders')).toBeInTheDocument();
      expect(within(needsYou).queryByText('Should not render')).not.toBeInTheDocument();
      expect(within(needsYou).getByText(/Since yesterday: 3 new enquiries · 7 messages in · 1 bookings · 2 payments/)).toBeInTheDocument();
      expect(within(needsYou).getByText(/median first reply 4.5 h/)).toBeInTheDocument();
      expect(within(needsYou).getByText(/Gmail has not refreshed for over a day/)).toBeInTheDocument();
      // The browser list is replaced, not merged.
      expect(within(needsYou).queryByText('Waiting for your reply')).not.toBeInTheDocument();
    });

    describe('clients waiting on a reply', () => {
      const silent = {
        key: 'silent-c9', kind: 'client_follow_up_due', section: 'waiting_on_clients',
        reason: 'client_follow_up_due', artist_id: 'a1', client_id: 'c9', subject: 'Quiet Client',
        href: '/inbox/v9', at: '2026-08-20T08:00:00Z', detail: 'awaiting_artist_review', sla_state: 'due',
        ai_suggestion: null, urgent: false,
        acknowledgement: { kind: 'client_silence', entity_id: 'c9', observed_at: '2026-08-20T08:00:00Z' },
        context: {
          conversation_id: 'v9', channel: 'instagram', message_type: 'text',
          preview: 'I can offer Saturday or Sunday', client_reacted: true,
        },
      };
      const withSilent = () => {
        const base = pulse(true);
        return { ...base, items: [...base.items, silent] };
      };
      const waitingSection = async () => {
        const heading = await screen.findByRole('heading', { level: 2, name: 'Waiting on clients · 1' });
        return heading.closest('section') as HTMLElement;
      };

      it('keeps them out of "Needs you now" in their own folded block', async () => {
        renderWithSession(<App />, { role: 'owner', path: '/', todayPulse: withSilent() });
        const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
          .closest('section') as HTMLElement;
        await within(needsYou).findByText('Server Pulse Client');
        expect(within(needsYou).queryByText('Quiet Client')).not.toBeInTheDocument();

        const section = await waitingSection();
        expect(within(section).getByText('up to 12 d')).toBeInTheDocument();
        expect(within(section).queryByText('Quiet Client')).not.toBeInTheDocument();
        fireEvent.click(within(section).getByRole('button', { expanded: false }));
        const row = within(section).getByText('Quiet Client').closest('.row') as HTMLElement;
        expect(within(row).getByText('12 d without a reply')).toBeInTheDocument();
        expect(within(row).getByText(/Instagram/)).toBeInTheDocument();
        expect(within(row).getByText(/client reacted/)).toBeInTheDocument();
        expect(within(row).getByText('You: I can offer Saturday or Sunday')).toBeInTheDocument();
        expect(within(row).getByText('Quiet Client').closest('a')).toHaveAttribute('href', '#/inbox/v9');
      });

      it('opens the block when Statistics links to it', async () => {
        renderWithSession(<App />, { role: 'owner', path: '/?waiting=1', todayPulse: withSilent() });
        const section = await waitingSection();
        expect(within(section).getByText('Quiet Client')).toBeInTheDocument();
      });

      it('hides a client for the cycle and can undo it', async () => {
        const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
        renderWithSession(<App />, { role: 'owner', path: '/?waiting=1', todayPulse: withSilent(), rpcCalls });
        const section = await waitingSection();
        fireEvent.click(within(section).getByRole('button', { name: "Don't remind" }));
        await waitFor(() => expect(rpcCalls.some((call) => call.name === 'acknowledge_attention_item')).toBe(true));
        expect(rpcCalls.find((call) => call.name === 'acknowledge_attention_item')?.args).toEqual({
          p_artist_id: 'a1', p_item_kind: 'client_silence', p_entity_id: 'c9', p_observed_at: '2026-08-20T08:00:00Z',
        });
        fireEvent.click(await within(section).findByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(rpcCalls.some((call) => call.name === 'clear_attention_acknowledgement')).toBe(true));
        expect(rpcCalls.find((call) => call.name === 'clear_attention_acknowledgement')?.args).toEqual({
          p_artist_id: 'a1', p_item_kind: 'client_silence', p_entity_id: 'c9',
        });
        // Nothing about the enquiry, booking or conversation changes.
        expect(rpcCalls.some((call) => call.name === 'transition_enquiry_status')).toBe(false);
        expect(rpcCalls.some((call) => call.name === 'queue_communication_message')).toBe(false);
      });

      it('postpones a client by three days, a week or a month', async () => {
        const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
        renderWithSession(<App />, { role: 'owner', path: '/?waiting=1', todayPulse: withSilent(), rpcCalls });
        const section = await waitingSection();
        fireEvent.click(within(section).getByRole('button', { name: 'Later' }));
        const choices = within(section).getByRole('group', { name: 'Later' });
        expect(within(choices).getByRole('button', { name: 'In a week' })).toBeInTheDocument();
        expect(within(choices).getByRole('button', { name: 'In a month' })).toBeInTheDocument();
        fireEvent.click(within(choices).getByRole('button', { name: 'In 3 days' }));
        await waitFor(() => expect(rpcCalls.some((call) => call.name === 'snooze_attention_item')).toBe(true));
        const args = rpcCalls.find((call) => call.name === 'snooze_attention_item')?.args as Record<string, string>;
        expect(args.p_item_kind).toBe('client_silence');
        expect(args.p_observed_at).toBe('2026-08-20T08:00:00Z');
        const days = (new Date(args.p_resurface_at).getTime() - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(2.9);
        expect(days).toBeLessThan(3.1);
        expect(await within(section).findByText(/Quiet Client is hidden until/)).toBeInTheDocument();
      });

      it('offers no decisions to a read-only viewer', async () => {
        renderWithSession(<App />, { role: 'read_only', path: '/?waiting=1', todayPulse: withSilent() });
        const section = await waitingSection();
        expect(within(section).getByText('Quiet Client')).toBeInTheDocument();
        expect(within(section).queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
        expect(within(section).queryByRole('button', { name: "Don't remind" })).not.toBeInTheDocument();
      });

      it('says when it cannot tell who is waiting, instead of an empty block', async () => {
        renderWithSession(<App />, { role: 'owner', path: '/?waiting=1', todayPulse: pulse(false) });
        expect(await screen.findByText(/Who is waiting cannot be worked out right now/)).toBeInTheDocument();
      });
    });

    it('renders an enabled server pulse even when a supplemental read fails', async () => {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/',
        todayPulse: pulse(true),
        failTable: 'activity_log',
      });

      const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
        .closest('section') as HTMLElement;
    await waitFor(() => expect(within(needsYou).queryByText('Loading today…')).not.toBeInTheDocument());
      expect(await within(needsYou).findByText('Server Pulse Client')).toBeInTheDocument();
      expect(within(needsYou).getByText('Deposit paid, no session booked')).toBeInTheDocument();
    });
  });
});
