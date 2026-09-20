import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { ENQUIRY_ID, renderWithSession } from './fixtures';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-09-20T12:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('follow-up workspace', () => {
  it('reads bounded status buckets and completes work through the existing RPC', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];

    renderWithSession(<App />, {
      role: 'owner',
      path: '/follow-ups',
      queryCalls,
      rpcCalls,
    });

    expect(await screen.findByText('Overdue · 1')).toBeInTheDocument();
    expect(screen.getByText('Fixture Client')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Fixture Client/ })).toHaveAttribute(
      'href',
      `#/enquiries/${ENQUIRY_ID}`,
    );

    const statusReads = queryCalls
      .filter((call) => call.table === 'follow_ups' && call.method === 'in' && call.args[0] === 'status')
      .map((call) => call.args[1]);
    expect(statusReads).toContainEqual(['open']);
    expect(statusReads).toContainEqual(['done', 'cancelled']);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(rpcCalls.find((call) => call.name === 'complete_follow_up')?.args).toEqual({
        p_follow_up_id: 'fu-1',
      });
    });
  });

  it('keeps the workspace readable for read-only staff without a completion control', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/follow-ups' });

    expect(await screen.findByText('Overdue · 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });
});
