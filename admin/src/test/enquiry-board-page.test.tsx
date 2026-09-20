import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { ENQUIRY_BOARD_STATUSES } from '../lib/enquiry-board';
import { ENQUIRY_ID, renderWithSession } from './fixtures';

beforeEach(() => {
  window.localStorage.removeItem('vishar-crm-enquiries-view');
});

describe('enquiry board page', () => {
  it('reads only active board statuses and changes state through the authoritative transition RPC', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];

    renderWithSession(<App />, {
      role: 'owner',
      path: '/enquiries',
      queryCalls,
      rpcCalls,
    });

    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));

    await waitFor(() => {
      const activeRead = queryCalls.find(
        (call) => call.table === 'enquiries' && call.method === 'in' && call.args[0] === 'status'
      );
      expect(activeRead?.args[1]).toEqual([...ENQUIRY_BOARD_STATUSES]);
    });

    const move = await screen.findByRole('combobox', {
      name: 'Move Fixture Client to another stage',
    });
    fireEvent.change(move, { target: { value: 'reviewing' } });

    await waitFor(() => {
      expect(rpcCalls.find((call) => call.name === 'transition_enquiry_status')?.args).toEqual({
        p_enquiry_id: ENQUIRY_ID,
        p_to_status: 'reviewing',
      });
    });
  });

  it('keeps the board useful for read-only staff without exposing a write control', async () => {
    renderWithSession(<App />, {
      role: 'read_only',
      path: '/enquiries',
    });

    await screen.findByText('Fixture Client');
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));

    expect(await screen.findByText('New')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Move Fixture Client/ })).not.toBeInTheDocument();
  });
});
