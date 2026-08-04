import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { CalendarProvider, PaymentStatus, SessionStatus } from './types';

export type AppointmentType =
  | 'tattoo_session'
  | 'in_person_consultation'
  | 'video_consultation'
  | 'touch_up';

export interface Appointment {
  id: string;
  artist_id: string;
  client_id: string;
  enquiry_id: string | null;
  project_id: string | null;
  appointment_type: AppointmentType;
  status: SessionStatus;
  start_at: string;
  end_at: string;
  duration_hours: number | null;
  currency: string;
  payment_status: PaymentStatus;
  calendar_provider: CalendarProvider;
  calendar_event_id: string | null;
  calendar_version: number;
  notes: string | null;
  cancelled_at: string | null;
}

export interface AppointmentConflict {
  appointment_id: string;
  appointment_type: AppointmentType;
  status: SessionStatus;
  start_at: string;
  end_at: string;
  client_id: string;
  enquiry_id: string | null;
  project_id: string | null;
}

export interface ScheduleAppointmentInput {
  artistId: string;
  clientId: string;
  appointmentType: AppointmentType;
  startAt: string;
  endAt: string;
  status?: Extract<SessionStatus, 'draft' | 'proposed' | 'confirmed'>;
  enquiryId?: string | null;
  projectId?: string | null;
  notes?: string | null;
}

function unwrap<T>(result: { data: T | null; error: any }, what: string): T {
  if (result.error) {
    throw new ApiError(friendlyMessage(result.error, what), result.error);
  }
  return (result.data ?? ([] as unknown)) as T;
}

export function createAppointmentApi(client: CrmClient) {
  return {
    async listAppointments(filters: {
      artistId?: string;
      projectId?: string;
      clientId?: string;
      appointmentType?: AppointmentType;
    } = {}): Promise<Appointment[]> {
      let query = client
        .from('sessions')
        .select('id, artist_id, client_id, enquiry_id, project_id, appointment_type, status, start_at, end_at, duration_hours, currency, payment_status, calendar_provider, calendar_event_id, calendar_version, notes, cancelled_at')
        .order('start_at', { ascending: true })
        .limit(300);

      if (filters.artistId) query = query.eq('artist_id', filters.artistId);
      if (filters.projectId) query = query.eq('project_id', filters.projectId);
      if (filters.clientId) query = query.eq('client_id', filters.clientId);
      if (filters.appointmentType) query = query.eq('appointment_type', filters.appointmentType);

      return unwrap<Appointment[]>(await query, 'load appointments');
    },

    async scheduleAppointment(input: ScheduleAppointmentInput) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('schedule_appointment', {
          p_artist_id: input.artistId,
          p_client_id: input.clientId,
          p_appointment_type: input.appointmentType,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
          p_status: input.status ?? 'proposed',
          p_enquiry_id: input.enquiryId ?? null,
          p_project_id: input.projectId ?? null,
          p_notes: input.notes ?? null,
        }),
        'schedule that appointment'
      );
    },

    async setAppointmentStatus(appointmentId: string, status: SessionStatus) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('set_appointment_status', {
          p_appointment_id: appointmentId,
          p_status: status,
        }),
        'change that appointment'
      );
    },

    async listAppointmentConflicts(input: {
      artistId: string;
      startAt: string;
      endAt: string;
      excludeAppointmentId?: string | null;
    }): Promise<AppointmentConflict[]> {
      return unwrap<AppointmentConflict[]>(
        await client.rpc('list_appointment_conflicts', {
          p_artist_id: input.artistId,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
          p_exclude_appointment_id: input.excludeAppointmentId ?? null,
        }),
        'check appointment conflicts'
      );
    },
  };
}

export type AppointmentApi = ReturnType<typeof createAppointmentApi>;
