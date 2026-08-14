import { describe, expect, it, vi } from 'vitest';
import { createAppointmentApi } from '../lib/appointment-api';
import type { CrmClient } from '../lib/api';

function clientWithRpc() {
  const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
  const client = { rpc } as unknown as CrmClient;
  return { client, rpc };
}

describe('appointment API boundary', () => {
  it('maps a projectless consultation to the protected RPC exactly', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createAppointmentApi(client);

    await api.scheduleAppointment({
      artistId: 'artist-1',
      clientId: 'client-1',
      appointmentType: 'video_consultation',
      startAt: '2026-09-10T10:00:00.000Z',
      endAt: '2026-09-10T10:30:00.000Z',
      status: 'proposed',
      enquiryId: 'enquiry-1',
      projectId: null,
      notes: 'Internal only',
    });

    expect(rpc).toHaveBeenCalledWith('schedule_appointment', {
      p_artist_id: 'artist-1',
      p_client_id: 'client-1',
      p_appointment_type: 'video_consultation',
      p_start_at: '2026-09-10T10:00:00.000Z',
      p_end_at: '2026-09-10T10:30:00.000Z',
      p_status: 'proposed',
      p_enquiry_id: 'enquiry-1',
      p_project_id: null,
      p_notes: 'Internal only',
    });
  });

  it('uses the database conflict RPC rather than a browser-only rule', async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const api = createAppointmentApi({ rpc } as unknown as CrmClient);

    await api.listAppointmentConflicts({
      artistId: 'artist-1',
      startAt: '2026-09-10T10:00:00.000Z',
      endAt: '2026-09-10T11:00:00.000Z',
      excludeAppointmentId: 'appointment-1',
    });

    expect(rpc).toHaveBeenCalledWith('list_appointment_conflicts', {
      p_artist_id: 'artist-1',
      p_start_at: '2026-09-10T10:00:00.000Z',
      p_end_at: '2026-09-10T11:00:00.000Z',
      p_exclude_appointment_id: 'appointment-1',
    });
  });

  it('changes lifecycle state through the appointment RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createAppointmentApi(client);

    await api.setAppointmentStatus('appointment-1', 'confirmed');

    expect(rpc).toHaveBeenCalledWith('set_appointment_status', {
      p_appointment_id: 'appointment-1',
      p_status: 'confirmed',
    });
  });
});
