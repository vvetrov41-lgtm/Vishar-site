// The Statistics screen, rendered against the fake database's get_statistics.
//
// What is pinned: the order a phone reader meets (attention, headline, diary),
// money for exactly the viewer the database returns it to, actual and expected
// money kept apart, no change stated without history, and a phone-width render.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { renderWithSession, statisticsResult } from './fixtures';

const PINNED_NOW = new Date('2026-07-20T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderStatistics(role: 'owner' | 'booking_manager' | 'read_only', statistics?: unknown) {
  const result = renderWithSession(<App />, { role, path: '/statistics', statistics });
  await screen.findByRole('heading', { level: 2, name: 'Headline' });
  return result;
}

describe('Statistics screen', () => {
  it('reads one server answer instead of paging raw records', async () => {
    const { rpcCalls } = await renderStatistics('owner');
    expect(rpcCalls.filter((call) => call.name === 'get_statistics')).toHaveLength(1);
  });

  it('opens on the four headline numbers, then what needs attention, before any chart', async () => {
    await renderStatistics('owner');
    const attention = screen.getByRole('heading', { level: 2, name: 'Needs attention' });
    const headline = screen.getByRole('heading', { level: 2, name: 'Headline' });
    const diary = screen.getByRole('heading', { level: 2, name: 'Diary ahead' });
    expect(headline.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attention.compareDocumentPosition(diary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const section = attention.closest('section') as HTMLElement;
    // The fixture period starts before reply evidence was complete.
    expect(within(section).queryByText(/Enquiries without a reply/)).not.toBeInTheDocument();
    expect(screen.getByText(/Reply evidence is complete only from 4 October 2026/)).toBeInTheDocument();
    expect(within(section).getByText(/Meta ads: 8 enquiries old enough to judge, no tattoo booked/)).toBeInTheDocument();

    const kpis = headline.closest('section') as HTMLElement;
    for (const label of ['New enquiries', 'Tattoo bookings made', 'First reply', 'Enquiry to tattoo']) {
      expect(within(kpis).getByText(label)).toBeInTheDocument();
    }
    expect(within(kpis).getByText('6.5 h')).toBeInTheDocument();
    expect(within(kpis).getByText('33%')).toBeInTheDocument();
    expect(within(kpis).getByText('3 of 9 judged')).toBeInTheDocument();
  });

  it('jumps from the Meta attention alert to channels without changing the hash route', async () => {
    await renderStatistics('owner');
    const target = document.getElementById('stats-channels');
    expect(target).not.toBeNull();
    const scroll = vi.fn();
    target!.scrollIntoView = scroll;
    const originalHash = window.location.hash;

    fireEvent.click(screen.getByRole('button', { name: /Meta ads: 8 enquiries old enough to judge, no tattoo booked/ }));

    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(window.location.hash).toBe(originalHash);
    expect(screen.getByRole('heading', { level: 2, name: 'Headline' })).toBeInTheDocument();
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
  });

  it('shows the diary ahead week by week, in hours, with no utilisation percentage', async () => {
    await renderStatistics('owner');
    expect(screen.getByRole('list', { name: 'Diary ahead' }).querySelectorAll('[role="listitem"]')).toHaveLength(12);
    expect(screen.getByText(/6 tattoo sessions, 36 h in the next 12 weeks\. 4 more booked later\./)).toBeInTheDocument();
    expect(screen.queryByText(/utilisation/i)).not.toBeInTheDocument();
  });

  it('keeps the funnel against enquiries, with the answered step', async () => {
    await renderStatistics('owner');
    const funnel = screen.getByRole('heading', { level: 2, name: 'Enquiry to tattoo' }).closest('section') as HTMLElement;
    expect(within(funnel).getByText('Answered')).toBeInTheDocument();
    expect(within(funnel).getByText('Had a consultation')).toBeInTheDocument();
    expect(within(funnel).getByText('Median 4.5 days from enquiry to tattoo booking.')).toBeInTheDocument();
  });

  it('keeps actual money and expected money apart', async () => {
    await renderStatistics('owner');
    const money = (await screen.findByRole('heading', { level: 2, name: 'Money' })).closest('section') as HTMLElement;
    expect(within(money).getByText('Received')).toBeInTheDocument();
    expect(within(money).getByText('Expected, not yet money')).toBeInTheDocument();
    expect(within(money).getByText('£500.00')).toBeInTheDocument();
    expect(within(money).getByText('£250.00')).toBeInTheDocument();
  });

  it('shows the forecast with few saved prices, confirmed and estimated value apart', async () => {
    await renderStatistics('owner');
    const money = (await screen.findByRole('heading', { level: 2, name: 'Money' })).closest('section') as HTMLElement;
    // 6 of 19 priced: the forecast is still shown, and says how complete it is.
    expect(within(money).getByText('≈ £17,220.00')).toBeInTheDocument();
    const confirmed = within(money).getByText('Confirmed price').closest('.stats-forecast-part') as HTMLElement;
    expect(within(confirmed).getByText('£5,880.00')).toBeInTheDocument();
    const estimated = within(money).getByText('Estimated from rates').closest('.stats-forecast-part') as HTMLElement;
    expect(within(estimated).getByText('≈ £11,340.00')).toBeInTheDocument();
    // The remainder rests partly on estimates: it is labelled a forecast,
    // marked approximate, and the confirmed-only part is given beside it.
    const remaining = within(money).getByText('Forecast still to collect').closest('.stats-forecast-remaining') as HTMLElement;
    expect(within(remaining).getByText('≈ £15,720.00')).toBeInTheDocument();
    expect(within(remaining).getByText('Includes estimated prices. At confirmed prices alone: £4,380.00.')).toBeInTheDocument();
    expect(within(money).getByText('6 of 19 sessions have a confirmed price.')).toBeInTheDocument();
    expect(within(money).queryByText(/without a basis/)).not.toBeInTheDocument();
  });

  it('calls the remainder plain money owed only when every price is confirmed', async () => {
    const statistics = statisticsResult(true) as any;
    statistics.artists[0].current.finance = {
      ...statistics.artists[0].current.finance,
      forecast: {
        sessions: 2,
        pricing_configured: true,
        confirmed: { sessions: 2, value: [{ currency: 'GBP', amount: 1960 }], remaining_after_deposits: [{ currency: 'GBP', amount: 1460 }] },
        estimated: { sessions: 0, full_day: 0, hourly: 0, from_project_rate: 0, value: [] },
        no_basis: { sessions: 0, hours: 0 },
        expected_value: [{ currency: 'GBP', amount: 1960 }],
        deposits_paid: [{ currency: 'GBP', amount: 500 }],
        remaining_after_deposits: [{ currency: 'GBP', amount: 1460 }],
      },
    };
    await renderStatistics('owner', statistics);
    const remaining = (await screen.findByText('Still to collect at confirmed prices')).closest('.stats-forecast-remaining') as HTMLElement;
    expect(within(remaining).getByText('£1,460.00')).toBeInTheDocument();
    expect(within(remaining).queryByText(/≈/)).not.toBeInTheDocument();
    expect(screen.queryByText('Forecast still to collect')).not.toBeInTheDocument();
  });

  it('says plainly when an artist has no rates, and links to them for a finance manager', async () => {
    const statistics = statisticsResult(true) as any;
    statistics.artists[0].current.finance = {
      ...statistics.artists[0].current.finance,
      forecast: {
        sessions: 2,
        pricing_configured: false,
        confirmed: { sessions: 0, value: [], remaining_after_deposits: [] },
        estimated: { sessions: 0, full_day: 0, hourly: 0, from_project_rate: 0, value: [] },
        no_basis: { sessions: 2, hours: 14 },
        expected_value: [],
        deposits_paid: [],
        remaining_after_deposits: [],
      },
    };
    await renderStatistics('owner', statistics);
    const gap = await screen.findByText(/Sessions without a basis for an estimate: 2/);
    expect(gap.textContent).toContain('another artist\'s rates are never used');
    expect(within(gap).getByRole('link', { name: 'Set rates' }).getAttribute('href')).toBe('/payments');
    expect(screen.getByText('0 of 2 sessions have a confirmed price.')).toBeInTheDocument();
  });

  it('raises the unanswered alert once the period lies inside complete reply evidence', async () => {
    await renderStatistics('owner', { ...statisticsResult(true), from: '2026-10-05T23:00:00Z' });
    expect(screen.getByText('Enquiries without a reply: 2')).toBeInTheDocument();
  });

  it('shows waiting payments without a link to a page a view-only viewer cannot open', async () => {
    await renderStatistics('booking_manager', statisticsResult(true));
    const section = screen.getByRole('heading', { level: 2, name: 'Needs attention' }).closest('section') as HTMLElement;
    const item = within(section).getByText('Payment requests waiting to be paid: 1');
    expect(item.closest('a')).toBeNull();
  });

  it('links waiting payments for a finance manager', async () => {
    await renderStatistics('owner');
    const item = screen.getByText('Payment requests waiting to be paid: 1');
    // Through the hash router: a plain "/payments" left the CRM route for Today.
    expect(item.closest('a')?.getAttribute('href')).toBe('#/payments');
  });

  describe('clients waiting on a reply', () => {
    const waitingRow = (n: number) => ({
      key: `silent-c${n}`, kind: 'client_follow_up_due', section: 'waiting_on_clients',
      reason: 'client_follow_up_due', artist_id: 'a1', client_id: `c${n}`, subject: `Client ${n}`,
      href: `/inbox/v${n}`, at: '2026-07-10T12:00:00Z', detail: 'awaiting_artist_review', sla_state: 'due',
      ai_suggestion: null, urgent: false,
      acknowledgement: { kind: 'client_silence', entity_id: `c${n}`, observed_at: '2026-07-10T12:00:00Z' },
    });
    const pulse = (enabled: boolean, rows: number) => ({
      generated_at: '2026-07-20T12:00:00Z', enabled, artists: [],
      items: Array.from({ length: rows }, (_, index) => waitingRow(index + 1)),
    });

    it('counts the Today block and links to it', async () => {
      const { rpcCalls } = renderWithSession(<App />, { role: 'owner', path: '/statistics', todayPulse: pulse(true, 3) });
      const item = await screen.findByText('Clients to follow up now: 3 · no reply for 7+ days');
      expect(item.closest('a')?.getAttribute('href')).toBe('#/?waiting=1');
      const calls = rpcCalls.filter((call) => call.name === 'get_waiting_on_clients_count');
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual({ p_artist_id: null });
    });

    it('does not follow the period picker', async () => {
      const { rpcCalls } = renderWithSession(<App />, { role: 'owner', path: '/statistics', todayPulse: pulse(true, 2) });
      await screen.findByText('Clients to follow up now: 2 · no reply for 7+ days');
      fireEvent.click(screen.getByRole('button', { name: '90 days' }));
      await waitFor(() => expect(rpcCalls.filter((call) => call.name === 'get_statistics')).toHaveLength(2));
      expect(rpcCalls.filter((call) => call.name === 'get_waiting_on_clients_count')).toHaveLength(1);
    });

    it('says the number is unavailable instead of showing zero', async () => {
      renderWithSession(<App />, { role: 'owner', path: '/statistics', todayPulse: pulse(false, 0) });
      const item = await screen.findByText('Clients to follow up: temporarily unavailable');
      expect(item.closest('a')).toBeNull();
    });

    it('stays out of the way when nobody is waiting', async () => {
      renderWithSession(<App />, { role: 'owner', path: '/statistics', todayPulse: pulse(true, 0) });
      await screen.findByRole('heading', { level: 2, name: 'Headline' });
      await waitFor(() => expect(screen.queryByText(/temporarily unavailable/)).not.toBeInTheDocument());
      expect(screen.queryByText(/Clients to follow up now/)).not.toBeInTheDocument();
    });
  });

  it('shows no money at all where the database returned none', async () => {
    await renderStatistics('booking_manager', statisticsResult(false));
    expect(screen.queryByRole('heading', { level: 2, name: 'Money' })).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
    expect(screen.queryByText('Deposit paid')).not.toBeInTheDocument();
  });

  it('states no change against a window the CRM holds no history for', async () => {
    await renderStatistics('owner', statisticsResult(true, false));
    expect(screen.getByText('No comparison: the CRM holds no complete history for the period before this one.')).toBeInTheDocument();
    expect(screen.queryByText(/^was /)).not.toBeInTheDocument();
  });

  it('states changes when history covers the previous window', async () => {
    await renderStatistics('owner');
    expect(screen.getByText('Compared with the 30 days immediately before.')).toBeInTheDocument();
    expect(screen.getAllByText(/^was /).length).toBeGreaterThan(0);
  });

  it('asks the server for the new window when the period changes', async () => {
    const { rpcCalls } = await renderStatistics('owner');
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() => expect(rpcCalls.filter((call) => call.name === 'get_statistics')).toHaveLength(2));
    const [first, second] = rpcCalls.filter((call) => call.name === 'get_statistics');
    expect(second.args?.p_from).not.toBe(first.args?.p_from);
  });

  it('offers a custom range and refuses to apply a backwards one', async () => {
    await renderStatistics('owner');
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-31' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-07-01' } });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-07-31' } });
    expect(apply).toBeEnabled();
  });

  it('lists channels with deposits paid for a finance viewer', async () => {
    await renderStatistics('owner');
    const channels = screen.getByRole('heading', { level: 2, name: 'Where enquiries came from' }).closest('section') as HTMLElement;
    expect(within(channels).getByRole('rowheader', { name: 'Meta ads' })).toBeInTheDocument();
    expect(within(channels).getByRole('columnheader', { name: 'Deposit paid' })).toBeInTheDocument();
  });

  it('renders at a phone width', async () => {
    window.innerWidth = 390;
    await renderStatistics('owner');
    for (const title of ['Needs attention', 'Headline', 'Diary ahead', 'Enquiry to tattoo', 'Where enquiries came from', 'How clients heard about you']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    }
  });

  it('offers Statistics to every role that may read enquiries', async () => {
    await renderStatistics('read_only', statisticsResult(false));
    expect(screen.getByRole('heading', { level: 2, name: 'Headline' })).toBeInTheDocument();
  });
});
