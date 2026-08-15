import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { CLIENT_ID, ENQUIRY_ID, renderWithSession } from './fixtures';

describe('CRM record editing UI', () => {
  it('lets a booking manager edit canonical client details through the scoped RPC', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/clients/${CLIENT_ID}`, rpcCalls });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit client' }));
    const travelling = screen.getByLabelText('Travelling from');
    fireEvent.change(travelling, { target: { value: 'UK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'update_client_details');
      expect(call).toBeDefined();
      expect(call!.args?.p_client_id).toBe(CLIENT_ID);
      expect((call!.args?.p_client as Record<string, unknown>).travelling_from).toBe('UK');
    });
  });

  it('lets a booking manager edit enquiry project details without editing the submitted contact snapshot', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}`, rpcCalls });

    expect(await screen.findByText('+447700900099')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit enquiry' }));
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'November' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'update_enquiry_details');
      expect(call).toBeDefined();
      expect(call!.args?.p_enquiry_id).toBe(ENQUIRY_ID);
      expect((call!.args?.p_enquiry as Record<string, unknown>).preferred_timing).toBe('November');
    });
    expect(screen.getByText('+447700900099')).toBeInTheDocument();
  });

  it('offers post-intake reference upload to a booking manager but not destructive removal', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}` });

    expect(await screen.findByRole('button', { name: 'Add references' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows owner-only removal for an existing ready reference', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });

    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('gives read-only staff no edit or file-management affordances', async () => {
    renderWithSession(<App />, { role: 'read_only', path: `/enquiries/${ENQUIRY_ID}` });

    expect(await screen.findByText('Colour realism')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit enquiry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add references' })).not.toBeInTheDocument();

    renderWithSession(<App />, { role: 'read_only', path: `/clients/${CLIENT_ID}` });
    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit client' })).not.toBeInTheDocument();
  });
});
