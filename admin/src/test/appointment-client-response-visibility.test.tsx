import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import { createAppointmentApi, type Appointment } from '../lib/appointment-api';
import { AppointmentRow, clientResponseLabel } from '../pages/AppointmentsPage';

const BASE_APPOINTMENT: Appointment = {
  id: '55555555-5555-4555-8555-555555555555',
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  enquiry_id: null,
  project_id: null,
  appointment_type: 'in_person_consultation',
  status: 'confirmed',
  start_at: '2026-09-01T10:00:00Z',
  end_at: '2026-09-01T10:30:00Z',
  duration_hours: 0.5,
  currency: 'GBP',
  payment_status: 'unpaid',
  calendar_provider: 'none',
  calendar_event_id: null,
  calendar_version: 3,
  calendar_sync_status: 'not_connected',
  calendar_last_synced_version: null,
  calendar_last_synced_at: null,
  calendar_last_error_code: null,
  client_response: null,
  client_response_at: null,
  client_response_calendar_version: null,
  notes: null,
  cancelled_at: null,
};

function renderRow(appointment: Appointment) {
  return render(
    <AppointmentRow
      appointment={appointment}
      client={null}
      enquiry={null}
      project={null}
      language="en"
      statusLabel="Confirmed"
      paymentLabel="Unpaid"
      mayManage={false}
      changing={false}
      onStatus={() => undefined}
      onReschedule={async () => undefined}
    />,
  );
}

describe('appointment client response visibility', () => {
  it('reads authoritative client response fields from sessions', async () => {
    const select = vi.fn((_columns: string) => ({
      order: vi.fn(() => ({
        limit: vi.fn(async () => ({
          data: [{
            ...BASE_APPOINTMENT,
            client_response: 'attendance_confirmed',
            client_response_at: '2026-08-31T09:15:00Z',
            client_response_calendar_version: 3,
          }],
          error: null,
        })),
      })),
    }));
    const from = vi.fn(() => ({ select }));
    const api = createAppointmentApi({ from } as unknown as CrmClient);

    const rows = await api.listAppointments();

    expect(from).toHaveBeenCalledWith('sessions');
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]?.[0]).toContain('client_response, client_response_at, client_response_calendar_version');
    expect(rows[0]).toMatchObject({
      client_response: 'attendance_confirmed',
      client_response_at: '2026-08-31T09:15:00Z',
      client_response_calendar_version: 3,
    });
  });

  it('shows attendance confirmation on the exact appointment row', () => {
    renderRow({
      ...BASE_APPOINTMENT,
      client_response: 'attendance_confirmed',
      client_response_at: '2026-08-31T09:15:00Z',
      client_response_calendar_version: 3,
    });

    const badge = screen.getByText(/Client confirmed/);
    expect(badge).toHaveClass('badge', 'ok');
  });

  it('makes a reschedule request visually prominent on the exact appointment row', () => {
    renderRow({
      ...BASE_APPOINTMENT,
      client_response: 'reschedule_requested',
      client_response_at: '2026-08-31T09:20:00Z',
      client_response_calendar_version: 3,
    });

    const badge = screen.getByText(/Client requested reschedule/);
    expect(badge).toHaveClass('badge', 'warn');
  });

  it('keeps operator wording available in both CRM languages', () => {
    expect(clientResponseLabel('attendance_confirmed', 'ru')).toBe('Клиент подтвердил');
    expect(clientResponseLabel('reschedule_requested', 'ru')).toBe('Клиент просит перенос');
  });
});
