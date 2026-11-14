import { describe, expect, it, vi } from 'vitest';
import { createProjectOperationsApi } from '../lib/project-operations-api';
import type { CrmClient } from '../lib/api';

function clientWithRpc() {
  const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
  const client = { rpc } as unknown as CrmClient;
  return { client, rpc };
}

describe('project operations API boundary', () => {
  it('creates a client project with a caller-stable request UUID', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createProjectOperationsApi(client);
    await api.createClientProject({
      requestId: 'project-request-id',
      clientId: 'known-client',
      artistId: 'artist-1',
      title: '  Raven sleeve  ',
      description: '  Black and grey  ',
    });
    expect(rpc).toHaveBeenCalledWith('create_client_project', {
      p_project_id: 'project-request-id',
      p_client_id: 'known-client',
      p_artist_id: 'artist-1',
      p_title: 'Raven sleeve',
      p_description: 'Black and grey',
    });
  });

  it('updates a project description with optimistic concurrency and routes archive through its own RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createProjectOperationsApi(client);
    await api.updateProjectDescription('project-1', 'New design', 'Old design');
    await api.setProjectArchiveState('project-1', true);
    await api.setProjectArchiveState('project-1', false);

    expect(rpc).toHaveBeenNthCalledWith(1, 'update_project_description', {
      p_project_id: 'project-1',
      p_description: 'New design',
      p_expected_description: 'Old design',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'set_project_archive_state', {
      p_project_id: 'project-1', p_archived: true,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'set_project_archive_state', {
      p_project_id: 'project-1', p_archived: false,
    });
  });

  it('updates the estimate only through the canonical estimate RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createProjectOperationsApi(client);

    await api.updateProjectEstimate({
      projectId: 'project-1',
      hourlyRate: 140,
      estimateTotal: 1400,
      estimatedSessions: 2,
      estimatedHours: 10,
      currency: 'GBP',
    });

    expect(rpc).toHaveBeenCalledWith('update_project_estimate', {
      p_project_id: 'project-1',
      p_hourly_rate: 140,
      p_estimate_total: 1400,
      p_estimated_sessions: 2,
      p_estimated_hours: 10,
      p_currency: 'GBP',
    });
  });

  it('changes project lifecycle through the named artist-scoped RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createProjectOperationsApi(client);

    await api.setProjectStatus('project-1', 'active');

    expect(rpc).toHaveBeenCalledWith('set_project_status', {
      p_project_id: 'project-1',
      p_status: 'active',
    });
  });

  it('stores appointment notes through create_internal_note with the session as the only link', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createProjectOperationsApi(client);

    await api.createAppointmentInternalNote('appointment-1', 'Client may arrive 15 minutes early.');

    expect(rpc).toHaveBeenCalledWith('create_internal_note', {
      p_body: 'Client may arrive 15 minutes early.',
      p_client_id: null,
      p_enquiry_id: null,
      p_project_id: null,
      p_session_id: 'appointment-1',
    });
  });
});
