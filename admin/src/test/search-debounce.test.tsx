import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { SEARCH_DEBOUNCE_MS } from '../lib/use-debounced-value';
import { renderWithSession } from './fixtures';

async function advanceDebounce(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('list search debounce', () => {
  it('waits for enquiry typing to settle and sends only the final reference search', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/enquiries',
      queryCalls,
    });

    const input = await screen.findByRole('searchbox', { name: /search enquiries/i });
    await screen.findByText('ENQ-2026-0001');
    queryCalls.length = 0;
    vi.useFakeTimers();

    fireEvent.change(input, { target: { value: 'ENQ' } });
    await advanceDebounce(200);
    fireEvent.change(input, { target: { value: 'ENQ-2026-0099' } });

    // Enquiry search now matches the reference or the client, so it is an `or`
    // filter on enquiries rather than a single reference ilike.
    await advanceDebounce(SEARCH_DEBOUNCE_MS - 1);
    expect(queryCalls.filter((call) => call.table === 'enquiries' && call.method === 'or')).toEqual([]);

    await advanceDebounce(1);
    const enquirySearches = queryCalls.filter(
      (call) => call.table === 'enquiries' && call.method === 'or'
    );
    expect(enquirySearches).toHaveLength(1);
    expect(enquirySearches[0].args[0]).toContain('reference_number.ilike.*ENQ-2026-0099*');
  });

  it('debounces client search and trims surrounding whitespace before querying', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/clients',
      queryCalls,
    });

    const input = await screen.findByRole('searchbox');
    await screen.findByText('Fixture Client');
    queryCalls.length = 0;
    vi.useFakeTimers();

    fireEvent.change(input, { target: { value: '  Fixture Client  ' } });

    // Client search moved from a single `full_name` ilike to an `or` filter
    // across every identifier a message can arrive with, so the debounce is
    // asserted against that call instead.
    await advanceDebounce(SEARCH_DEBOUNCE_MS - 1);
    expect(queryCalls.filter((call) => call.table === 'clients' && call.method === 'or')).toEqual([]);

    await advanceDebounce(1);
    const clientSearches = queryCalls.filter(
      (call) => call.table === 'clients' && call.method === 'or'
    );
    expect(clientSearches).toHaveLength(1);
    // Trimmed, and no `%` padding leaks into PostgREST's own `*` wildcards.
    expect(clientSearches[0].args[0]).toContain('full_name.ilike.*Fixture Client*');
    expect(clientSearches[0].args[0]).not.toContain('%');
  });
});
