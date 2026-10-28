import type { Appointment } from './appointment-api';
import type { Language } from './i18n';

const CONSULTATION_TYPES = new Set(['in_person_consultation', 'video_consultation']);

/**
 * An ended consultation still `confirmed`: it may or may not have taken
 * place. Derived from the clock, never stored, so it cannot go stale. The
 * operator records the outcome (completed or no_show); a later tattoo booking
 * for the client records it automatically on the server.
 */
export function consultationAwaitingOutcome(
  appointment: Pick<Appointment, 'appointment_type' | 'status' | 'end_at'>,
  now: number = Date.now(),
): boolean {
  return CONSULTATION_TYPES.has(appointment.appointment_type)
    && appointment.status === 'confirmed'
    && Date.parse(appointment.end_at) <= now;
}

export type AppointmentAttendanceState = 'outcome_pending' | 'client_confirmed' | 'reschedule_requested' | 'awaiting_client';

/** Attendance state of a `confirmed` booking; null for any other lifecycle status. Never reads a stale reply. */
export function appointmentAttendanceState(appointment: Appointment): AppointmentAttendanceState | null {
  if (appointment.status !== 'confirmed') return null;
  if (consultationAwaitingOutcome(appointment)) return 'outcome_pending';
  const current = appointment.client_response_calendar_version === appointment.calendar_version;
  if (current && appointment.client_response === 'attendance_confirmed') return 'client_confirmed';
  if (current && appointment.client_response === 'reschedule_requested') return 'reschedule_requested';
  return 'awaiting_client';
}

const ATTENDANCE_LABELS: Record<Language, Record<AppointmentAttendanceState, string>> = {
  en: { outcome_pending: 'Ended, outcome not confirmed', client_confirmed: 'Client confirmed', reschedule_requested: 'Client requested reschedule', awaiting_client: 'Awaiting client confirmation' },
  ru: { outcome_pending: 'Прошла, результат не подтверждён', client_confirmed: 'Клиент подтвердил', reschedule_requested: 'Клиент просит перенос', awaiting_client: 'Ожидаем подтверждения клиента' },
};

/** Attendance is distinct from booking lifecycle. Never display a stale reply. */
export function appointmentDisplayStatus(appointment: Appointment, language: Language, lifecycleLabel: string): string {
  const state = appointmentAttendanceState(appointment);
  return state ? ATTENDANCE_LABELS[language][state] : lifecycleLabel;
}
