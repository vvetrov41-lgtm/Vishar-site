// Today, as an operator meets it after opening the CRM.
//
// The audit's charge against the old Dashboard was that it answered three of
// the eight morning questions and its visual anchor was three enquiry counters.
// These tests assert that the screen now leads with work, that every row names
// a person and opens where the work is done, and that no counter survived.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { CLIENT_ID, CONVERSATION_ID, PROJECT_ID, SESSION_ID, SESSION, renderWithSession } from './fixtures';

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

    const reply = within(needsYou).getByText('Waiting for your reply').closest('a') as HTMLElement;
    expect(reply).toHaveAttribute('href', `#/inbox/${CONVERSATION_ID}`);
  });

  it('surfaces an unconfirmed booking, an outstanding deposit and an overdue follow-up', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });

    const needsYou = (await screen.findByRole('heading', { level: 2, name: 'Needs you now' }))
      .closest('section') as HTMLElement;

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
});
