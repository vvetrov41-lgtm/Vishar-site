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

    expect(await screen.findByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument();
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

  it('offers only 15 to 30 minute consultation shortcuts', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/appointments' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument();
    // The duration shortcuts live in the shared booking panel now, which needs
    // a client before it will offer anything.
    const search = await screen.findByLabelText('Find the client');
    fireEvent.change(search, { target: { value: 'Fixture' } });
    fireEvent.click(await screen.findByRole('button', { name: /Fixture Client/ }, { timeout: 3000 }));

    fireEvent.change(await screen.findByRole('combobox', { name: 'Appointment type' }), {
      target: { value: 'video_consultation' },
    });

    expect(screen.getByRole('button', { name: '15 min' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '20 min' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 min' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '45 min' })).not.toBeInTheDocument();
  });

  it('keeps lifecycle controls hidden from read-only users', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/appointments' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Confirm:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel:/ })).not.toBeInTheDocument();
  });
});
