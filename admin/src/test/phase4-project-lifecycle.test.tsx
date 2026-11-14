import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { ClientProjectCreatePanel } from '../components/ClientProjectCreatePanel';
import {
  CLIENT_ID, PROJECT, PROJECT_ID, renderWithSession,
} from './fixtures';

describe('Phase 4: project creation and archive UX', () => {
  it('retries the same create request UUID after a network failure', async () => {
    const createClientProject = vi.fn()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ project_id: PROJECT_ID, created: false });

    renderWithSession(
      <ClientProjectCreatePanel
        clientId={CLIENT_ID}
        artistId={PROJECT.artist_id}
        api={{ createClientProject }}
        language="en"
      />,
      { role: 'owner', path: `/clients/${CLIENT_ID}` }
    );

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Project title' }), {
      target: { value: 'Raven sleeve' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Black and grey' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(createClientProject).toHaveBeenCalledTimes(2));

    const first = createClientProject.mock.calls[0][0];
    const second = createClientProject.mock.calls[1][0];
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.requestId).toBe(first.requestId);
    expect(first.clientId).toBe(CLIENT_ID);
    expect(second.title).toBe('Raven sleeve');
  });

  it('requires an explicit artist selection when no artist can be inferred', async () => {
    renderWithSession(
      <ClientProjectCreatePanel
        clientId={CLIENT_ID}
        artistId={null}
        api={{ createClientProject: vi.fn() }}
        language="en"
      />,
      { role: 'owner', path: `/clients/${CLIENT_ID}` }
    );
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(screen.getByText('Choose an artist in the selector above first.')).toBeInTheDocument();
  });

  it('offers the project action on a client card to a manager but not a read-only account', async () => {
    const manager = renderWithSession(<App />, { role: 'booking_manager', path: `/clients/${CLIENT_ID}` });
    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    manager.unmount();

    renderWithSession(<App />, { role: 'read_only', path: `/clients/${CLIENT_ID}` });
    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('shows archived projects as read-only history with a restore action only for the owner', async () => {
    const archivedProject = { ...PROJECT, archived_at: '2026-09-01T12:00:00Z', status: 'completed' };
    renderWithSession(<App />, {
      role: 'owner',
      path: `/projects/${PROJECT_ID}`,
      tableRows: { projects: [archivedProject] },
    });

    expect(await screen.findByText(/This project is archived/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore from archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit description' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book a session' })).not.toBeInTheDocument();
  });
});
