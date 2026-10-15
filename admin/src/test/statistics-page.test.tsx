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

  it('puts what needs attention first, then the four headline numbers', async () => {
    await renderStatistics('owner');
    const attention = screen.getByRole('heading', { level: 2, name: 'Needs attention' });
    const headline = screen.getByRole('heading', { level: 2, name: 'Headline' });
    expect(attention.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const section = attention.closest('section') as HTMLElement;
    expect(within(section).getByText('Enquiries without a reply: 2')).toBeInTheDocument();
    expect(within(section).getByText(/Meta ads: 8 enquiries old enough to judge, no tattoo booked/)).toBeInTheDocument();

    const kpis = headline.closest('section') as HTMLElement;
    for (const label of ['New enquiries', 'Tattoo bookings made', 'First reply', 'Enquiry to tattoo']) {
      expect(within(kpis).getByText(label)).toBeInTheDocument();
    }
    expect(within(kpis).getByText('6.5 h')).toBeInTheDocument();
    expect(within(kpis).getByText('33%')).toBeInTheDocument();
    expect(within(kpis).getByText('3 of 9 judged')).toBeInTheDocument();
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

  it('keeps actual money and expected money apart, and holds the forecast until prices exist', async () => {
    await renderStatistics('owner');
    const money = (await screen.findByRole('heading', { level: 2, name: 'Money' })).closest('section') as HTMLElement;
    expect(within(money).getByText('Received')).toBeInTheDocument();
    expect(within(money).getByText('Expected, not yet money')).toBeInTheDocument();
    expect(within(money).getByText('£500.00')).toBeInTheDocument();
    expect(within(money).getByText('£250.00')).toBeInTheDocument();
    // 2 of 10 future sessions are priced: no booked value is printed.
    expect(within(money).queryByText('£1,960.00')).not.toBeInTheDocument();
    expect(within(money).getByText(/A price is set on 2 of 10 future sessions/)).toBeInTheDocument();
  });

  it('prints the forecast once most sessions carry a price', async () => {
    const statistics = statisticsResult(true) as any;
    statistics.artists[0].current.finance = {
      ...statistics.artists[0].current.finance,
      forecast: { ...statistics.artists[0].current.finance.forecast, priced_sessions: 9 },
    };
    await renderStatistics('owner', statistics);
    expect(await screen.findByText('£1,960.00')).toBeInTheDocument();
    expect(screen.getByText('£1,460.00')).toBeInTheDocument();
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
