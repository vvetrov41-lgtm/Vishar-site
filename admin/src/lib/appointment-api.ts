import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { CalendarProvider, PaymentStatus, SessionStatus } from './types';

export type AppointmentType =
  | 'tattoo_session'
  | 'in_person_consultation'
  | 'video_consultation'
  | 'touch_up';

export type CalendarSyncStatus =
  | 'not_connected'
  | 'queued'
  | 'synced'
  | 'retrying'
  | 'failed';

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
  calendar_sync_status: CalendarSyncStatus;
  calendar_last_synced_version: number | null;
  calendar_last_synced_at: string | null;
  calendar_last_error_code: string | null;
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

function normaliseAppointment(row: Partial<Appointment> & Pick<Appointment, 'id' | 'artist_id' | 'status' | 'start_at' | 'end_at'>): Appointment {
  return {
    ...row,
    client_id: row.client_id ?? '',
    enquiry_id: row.enquiry_id ?? null,
    project_id: row.project_id ?? null,
    appointment_type: row.appointment_type ?? 'tattoo_session',
    duration_hours: row.duration_hours ?? null,
    currency: row.currency ?? 'GBP',
    payment_status: row.payment_status ?? 'unpaid',
    calendar_provider: row.calendar_provider ?? 'none',
    calendar_event_id: row.calendar_event_id ?? null,
    calendar_version: row.calendar_version ?? 0,
    calendar_sync_status: row.calendar_sync_status ?? 'not_connected',
    calendar_last_synced_version: row.calendar_last_synced_version ?? null,
    calendar_last_synced_at: row.calendar_last_synced_at ?? null,
    calendar_last_error_code: row.calendar_last_error_code ?? null,
    notes: row.notes ?? null,
    cancelled_at: row.cancelled_at ?? null,
  } as Appointment;
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
        .select('id, artist_id, client_id, enquiry_id, project_id, appointment_type, status, start_at, end_at, duration_hours, currency, payment_status, calendar_provider, calendar_event_id, calendar_version, calendar_sync_status, calendar_last_synced_version, calendar_last_synced_at, calendar_last_error_code, notes, cancelled_at')
        .order('start_at', { ascending: true })
        .limit(300);

      if (filters.artistId) query = query.eq('artist_id', filters.artistId);
      if (filters.projectId) query = query.eq('project_id', filters.projectId);
      if (filters.clientId) query = query.eq('client_id', filters.clientId);
      if (filters.appointmentType) query = query.eq('appointment_type', filters.appointmentType);

      const rows = unwrap<Array<Partial<Appointment> & Pick<Appointment, 'id' | 'artist_id' | 'status' | 'start_at' | 'end_at'>>>(
        await query,
        'load appointments'
      );
      return rows.map(normaliseAppointment);
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

    async rescheduleAppointment(input: {
      appointmentId: string;
      startAt: string;
      endAt: string;
    }) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('reschedule_appointment', {
          p_appointment_id: input.appointmentId,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
        }),
        'reschedule that appointment'
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
