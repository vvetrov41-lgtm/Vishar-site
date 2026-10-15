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

/** Attendance is distinct from booking lifecycle. Never display a stale reply. */
export function appointmentDisplayStatus(appointment: Appointment, language: Language, lifecycleLabel: string): string {
  if (appointment.status !== 'confirmed') return lifecycleLabel;
  if (consultationAwaitingOutcome(appointment)) {
    return language === 'ru' ? 'Прошла, результат не подтверждён' : 'Ended, outcome not confirmed';
  }
  const current = appointment.client_response_calendar_version === appointment.calendar_version;
  if (current && appointment.client_response === 'attendance_confirmed') {
    return language === 'ru' ? 'Клиент подтвердил' : 'Client confirmed';
  }
  if (current && appointment.client_response === 'reschedule_requested') {
    return language === 'ru' ? 'Клиент просит перенос' : 'Client requested reschedule';
  }
  return language === 'ru' ? 'Ожидаем подтверждения клиента' : 'Awaiting client confirmation';
}
