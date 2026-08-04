import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import {
  PROJECT_ID,
  SESSION_ID,
  renderWithSession,
} from './fixtures';

describe('appointments queue', () => {
  it('links the related records and changes lifecycle through the appointment RPC', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments',
      rpcCalls,
    });

    expect(await screen.findByRole('heading', { level: 2, name: 'Appointments' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Project: Raven sleeve' }))
      .toHaveAttribute('href', `#/projects/${PROJECT_ID}`);

    fireEvent.click(screen.getByRole('button', { name: /^Confirm:/ }));

    await waitFor(() => {
      expect(rpcCalls).toContainEqual({
        name: 'set_appointment_status',
        args: {
          p_appointment_id: SESSION_ID,
          p_status: 'confirmed',
        },
      });
    });
  });

  it('keeps lifecycle controls hidden from read-only users', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/appointments' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Appointments' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Confirm:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel:/ })).not.toBeInTheDocument();
  });
});
