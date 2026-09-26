import { describe, expect, it, vi } from 'vitest';
import { createAppointmentApi, daysAgoIso } from '../lib/appointment-api';
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

  it('uses the atomic priced-booking RPC only when an explicit session price is present', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createAppointmentApi(client);

    await api.scheduleAppointment({
      artistId: 'artist-1',
      clientId: 'client-1',
      appointmentType: 'tattoo_session',
      startAt: '2026-11-10T10:00:00.000Z',
      endAt: '2026-11-10T17:00:00.000Z',
      status: 'proposed',
      projectId: 'project-1',
      price: 980,
    });

    expect(rpc).toHaveBeenCalledWith('schedule_appointment_with_price', {
      p_artist_id: 'artist-1',
      p_client_id: 'client-1',
      p_appointment_type: 'tattoo_session',
      p_start_at: '2026-11-10T10:00:00.000Z',
      p_end_at: '2026-11-10T17:00:00.000Z',
      p_status: 'proposed',
      p_enquiry_id: null,
      p_project_id: 'project-1',
      p_notes: null,
      p_price: 980,
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

  it('stores the explicit session price through the finance-guarded RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createAppointmentApi(client);

    await api.setAppointmentPrice('appointment-1', 980);

    expect(rpc).toHaveBeenCalledWith('set_appointment_price', {
      p_appointment_id: 'appointment-1',
      p_price: 980,
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

describe('appointment list bounds (audit M-5)', () => {
  function recordingClient() {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'limit', 'eq', 'gt', 'lt']) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
    const client = { from: () => builder } as unknown as CrmClient;
    return { client, calls };
  }

  it('reads one exact session by id instead of the earliest 300', async () => {
    const { client, calls } = recordingClient();
    await createAppointmentApi(client).listAppointments({ id: 'appointment-301' });
    expect(calls).toContainEqual(['eq', ['id', 'appointment-301']]);
  });

  it('bounds a window read on end_at and start_at', async () => {
    const { client, calls } = recordingClient();
    await createAppointmentApi(client).listAppointments({
      artistId: 'artist-1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });
    expect(calls).toContainEqual(['gt', ['end_at', '2026-09-01T00:00:00.000Z']]);
    expect(calls).toContainEqual(['lt', ['start_at', '2026-09-15T00:00:00.000Z']]);
  });

  it('computes a bounded look-back timestamp', () => {
    expect(daysAgoIso(90, new Date('2026-09-22T12:00:00.000Z'))).toBe('2026-06-24T12:00:00.000Z');
  });
});
