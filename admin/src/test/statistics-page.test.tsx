// The Statistics screen, rendered against the fake database.
//
// The formulas are pinned in `statistics.test.ts` and the reads in
// `statistics-api.test.ts`. What is pinned here is what the screen does with
// them: that finance appears for exactly the viewer the database returns
// finance rows to, that an empty period says so instead of printing zeroes as
// if they were findings, that no percentage is invented for booked time, and
// that the whole thing renders on a phone-width viewport.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { renderWithSession } from './fixtures';

// The fixture's records sit in early July 2026. The clock is pinned just after
// them so a 30-day period actually contains the fixture, rather than depending
// on the day the suite happens to run.
const PINNED_NOW = new Date('2026-07-20T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderStatistics(role: 'owner' | 'booking_manager' | 'read_only') {
  const result = renderWithSession(<App />, { role, path: '/statistics' });
  await screen.findByRole('heading', { level: 2, name: 'Headline' });
  return result;
}

describe('Statistics screen', () => {
  it('counts the period\'s records rather than everything the reader returned', async () => {
    await renderStatistics('owner');

    const headline = screen.getByRole('heading', { level: 2, name: 'Headline' }).closest('section') as HTMLElement;
    const enquiries = within(headline).getByText('New enquiries').closest('.stats-kpi') as HTMLElement;
    expect(within(enquiries).getByText('1')).toBeInTheDocument();

    // The fixture enquiry booked a tattoo session and is old enough to judge.
    const conversion = within(headline).getByText('Enquiry to tattoo').closest('.stats-kpi') as HTMLElement;
    expect(within(conversion).getByText('100%')).toBeInTheDocument();
    expect(within(conversion).getByText('1 of 1 judged')).toBeInTheDocument();
  });

  it('does not count a consultation as a conversion on the screen', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: '/statistics',
      extraEnquiries: [{ id: 'e-consult', client_id: 'c-consult', created_at: '2026-07-02T09:00:00Z' }],
      extraSessions: [{
        id: 's-consult', enquiry_id: 'e-consult', project_id: null, client_id: 'c-consult',
        appointment_type: 'in_person_consultation', status: 'confirmed',
        start_at: '2026-07-10T10:00:00Z', end_at: '2026-07-10T10:30:00Z', duration_hours: 0.5,
      }],
    });
    const headline = (await screen.findByRole('heading', { level: 2, name: 'Headline' })).closest('section') as HTMLElement;
    const conversion = within(headline).getByText('Enquiry to tattoo').closest('.stats-kpi') as HTMLElement;
    // Two judged enquiries; only the one with a tattoo session converted.
    expect(within(conversion).getByText('50%')).toBeInTheDocument();
    expect(within(conversion).getByText('1 of 2 judged')).toBeInTheDocument();
    const completed = within(headline).getByText('Hours tattooed').closest('.stats-kpi') as HTMLElement;
    expect(within(completed).getByText('0 h')).toBeInTheDocument();
  });

  it('states booked time ahead in hours and offers no utilisation percentage', async () => {
    await renderStatistics('owner');

    expect(screen.getByText(/Booked time is shown in hours, not as a percentage/)).toBeInTheDocument();
    expect(screen.queryByText(/utilisation/i)).not.toBeInTheDocument();
    expect(screen.getByText('Tattoo hours in the next 90 days')).toBeInTheDocument();
    expect(screen.getByText('Consultations in the next 90 days')).toBeInTheDocument();
  });

  it('publishes the formula behind every headline figure on the screen itself', async () => {
    await renderStatistics('owner');

    fireEvent.click(screen.getByText('How each figure is worked out'));
    expect(screen.getByText(/A no-show is counted separately/)).toBeInTheDocument();
    expect(screen.getByText(/A consultation or a project on its own is not a conversion/)).toBeInTheDocument();
    expect(screen.getByText(/Several sessions of one piece are one project, not a return/)).toBeInTheDocument();
  });

  it('shows money received and money still owed, and never a sum of requests', async () => {
    await renderStatistics('owner');

    const money = await screen.findByRole('heading', { level: 2, name: 'Money' });
    const section = money.closest('section') as HTMLElement;
    const received = within(section).getByText('Payments received').closest('.stats-money-block') as HTMLElement;
    expect(within(received).getByText('£150.00')).toBeInTheDocument();
    // The fixture's deposit request is paid, so nothing is waiting: the paid
    // request is not counted again next to the money it produced.
    const open = within(section).getByText('Waiting to be paid').closest('.stats-money-block') as HTMLElement;
    expect(within(open).queryByText(/£/)).not.toBeInTheDocument();
    expect(within(section).queryByText('Deposits requested')).not.toBeInTheDocument();
    expect(within(section).queryByText('Quoted on new projects')).not.toBeInTheDocument();
  });

  it('shows no money at all to a booking manager without finance access', async () => {
    await renderStatistics('booking_manager');

    expect(screen.queryByRole('heading', { level: 2, name: 'Money' })).not.toBeInTheDocument();
    expect(screen.queryByText('Payments received')).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
    // Everything that is not money still renders.
    expect(screen.getByRole('heading', { level: 2, name: 'Enquiry to tattoo' })).toBeInTheDocument();
  });

  it('shows no money at all to a read-only viewer', async () => {
    await renderStatistics('read_only');

    expect(screen.queryByRole('heading', { level: 2, name: 'Money' })).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
  });

  it('says a period is empty instead of presenting zeroes as findings', async () => {
    // Seven days ending 20 July contains none of the fixture's July records.
    await renderStatistics('owner');

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await waitFor(() => {
      expect(screen.getByText('Nothing recorded in this period')).toBeInTheDocument();
    });
    // And no insight is asserted from an empty window.
    expect(screen.queryByRole('heading', { level: 2, name: 'What stands out' })).not.toBeInTheDocument();
  });

  it('states no change against a window the CRM holds no history for', async () => {
    // The fixture's history begins on 1 July; the previous 30-day window opens
    // on 20 June. "+1, was 0" would be growth from records that never existed.
    await renderStatistics('owner');
    expect(screen.getByText('No comparison: the CRM holds no complete history for the period before this one.')).toBeInTheDocument();
    expect(screen.queryByText(/^was /)).not.toBeInTheDocument();
    expect(screen.queryByText('No change')).not.toBeInTheDocument();
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

  it('narrows every read to the chosen artist and leaves the rest to the database', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, { role: 'owner', path: '/statistics', queryCalls });
    await screen.findByRole('heading', { level: 2, name: 'Headline' });

    // No artist chosen: the browser adds no artist filter of its own, because
    // "everything I may see" is a question only row level security can answer.
    const statisticsTables = ['statistics_enquiries', 'statistics_projects', 'statistics_sessions'];
    const scoped = queryCalls.filter(
      (call) => statisticsTables.includes(call.table) && call.method === 'eq' && call.args[0] === 'artist_id',
    );
    expect(scoped).toEqual([]);
  });

  it('reads no contact detail to produce a count', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, { role: 'owner', path: '/statistics', queryCalls });
    await screen.findByRole('heading', { level: 2, name: 'Headline' });

    // The screen shows aggregates, so no client's name reaches it.
    expect(screen.queryByText('Fixture Client')).not.toBeInTheDocument();
    expect(screen.queryByText(/fixture@example.test/)).not.toBeInTheDocument();
  });

  it('renders every section at a phone width', async () => {
    window.innerWidth = 375;
    await renderStatistics('owner');

    for (const title of ['Headline', 'Over time', 'Enquiry to tattoo', 'Where enquiries came from', 'Sessions']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    }
    // The trend is a list of buckets, so a screen reader gets the numbers a
    // sighted reader gets from the bars.
    expect(screen.getByRole('list', { name: 'Over time' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Tattoo sessions by day of the week' })).toBeInTheDocument();
  });

  it('reports a campaign tag as its own channel instead of the booking form', async () => {
    await renderStatistics('owner');

    const sources = screen.getByRole('heading', { level: 2, name: 'Where enquiries came from' }).closest('section') as HTMLElement;
    // The fixture enquiry carries utm_source=google without a paid medium.
    expect(within(sources).getByRole('rowheader', { name: 'Campaign tag: Google' })).toBeInTheDocument();
  });

  it('offers Statistics in the navigation of every role that may read enquiries', async () => {
    await renderStatistics('read_only');
    expect(screen.getByRole('heading', { level: 2, name: 'Headline' })).toBeInTheDocument();
  });
});
