import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { CLIENT_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';
import { clearTodayCache } from '../lib/today-resource';

function pending() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const pulse = { enabled: true, generated_at: '2026-09-01T08:00:00Z', artists: [], items: [{
  key: 'conflict', kind: 'conflict', artist_id: VLADIMIR_ARTIST_ID, client_id: CLIENT_ID,
  subject: 'Independent pulse', href: `/clients/${CLIENT_ID}`, urgent: false,
  detail: 'deposit_paid_without_booking', acknowledgement: null,
}] };

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-09-01T08:00:00Z') }); });
afterEach(() => { clearTodayCache(); vi.useRealTimers(); });

describe('Today critical path', () => {
  it('shows pulse while appointments, enquiries, names and email remain pending', async () => {
    const barrier = pending();
    renderWithSession(<App />, { role: 'owner', todayPulse: pulse, path: '/',
      tableBarrier: Object.fromEntries(['sessions', 'enquiries', 'clients', 'email_messages', 'activity_log'].map((table) => [table, barrier.promise])),
    });
    expect(await screen.findByText('Independent pulse')).toBeVisible();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
    await act(async () => { barrier.resolve(); });
  });

  it('shows named schedule while pulse is pending without claiming attention is clear', async () => {
    const barrier = pending();
    renderWithSession(<App />, { role: 'owner', todayPulse: pulse, path: '/', rpcBarrier: { get_today_pulse: barrier.promise } });
    await screen.findByRole('heading', { level: 2, name: 'Today' });
    await waitFor(() => expect(document.querySelector('.today-context')?.textContent).toContain('1 session'));
    expect(screen.getAllByText('Loading today…').length).toBeGreaterThan(0);
    expect(screen.queryByText('Independent pulse')).not.toBeInTheDocument();
    await act(async () => { barrier.resolve(); });
    expect(await screen.findByText('Independent pulse')).toBeVisible();
  });

  it('reuses Today on return without issuing a second pulse during the freshness window', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'owner', todayPulse: pulse, path: '/', rpcCalls });
    expect(await screen.findByText('Independent pulse')).toBeVisible();
    fireEvent.click(screen.getAllByRole('link', { name: 'Clients' })[0]);
    await waitFor(() => expect(screen.queryByText('Independent pulse')).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('link', { name: 'Today' })[0]);
    expect(screen.getByText('Independent pulse')).toBeVisible();
    expect(rpcCalls.filter((call) => call.name === 'get_today_pulse')).toHaveLength(1);
  });

  it('cannot display another artist snapshot while the new scope is loading', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'owner', todayPulse: pulse, path: '/', rpcCalls });
    await screen.findByText('Independent pulse');
    // The hook ownership boundary is also tested separately; here verify the
    // actual scope control causes another RPC rather than reusing all-artists.
    const selector = screen.getByRole('combobox', { name: /artist/i });
    fireEvent.change(selector, { target: { value: VLADIMIR_ARTIST_ID } });
    await waitFor(() => expect(selector).toHaveValue(VLADIMIR_ARTIST_ID));
    await waitFor(() => expect(rpcCalls.filter((call) => call.name === 'get_today_pulse').at(-1)?.args?.p_artist_id).toBe(VLADIMIR_ARTIST_ID));
  });
});
