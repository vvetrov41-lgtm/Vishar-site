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

    const input = await screen.findByRole('searchbox', { name: /search by reference/i });
    await screen.findByText('ENQ-2026-0001');
    queryCalls.length = 0;
    vi.useFakeTimers();

    fireEvent.change(input, { target: { value: 'ENQ' } });
    await advanceDebounce(200);
    fireEvent.change(input, { target: { value: 'ENQ-2026-0099' } });

    await advanceDebounce(SEARCH_DEBOUNCE_MS - 1);
    expect(queryCalls.filter((call) => call.method === 'ilike')).toEqual([]);

    await advanceDebounce(1);
    expect(queryCalls.filter((call) => call.method === 'ilike')).toEqual([
      {
        table: 'enquiries',
        method: 'ilike',
        args: ['reference_number', '%ENQ-2026-0099%'],
      },
    ]);
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

    await advanceDebounce(SEARCH_DEBOUNCE_MS - 1);
    expect(queryCalls.filter((call) => call.method === 'ilike')).toEqual([]);

    await advanceDebounce(1);
    expect(queryCalls.filter((call) => call.method === 'ilike')).toEqual([
      {
        table: 'clients',
        method: 'ilike',
        args: ['full_name', '%Fixture Client%'],
      },
    ]);
  });
});
