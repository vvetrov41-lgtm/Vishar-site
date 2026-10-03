import type { Appointment } from './appointment-api';
import type { Language } from './i18n';

/** Attendance is distinct from booking lifecycle. Never display a stale reply. */
export function appointmentDisplayStatus(appointment: Appointment, language: Language, lifecycleLabel: string): string {
  if (appointment.status !== 'confirmed') return lifecycleLabel;
  const current = appointment.client_response_calendar_version === appointment.calendar_version;
  if (current && appointment.client_response === 'attendance_confirmed') {
    return language === 'ru' ? 'Клиент подтвердил' : 'Client confirmed';
  }
  if (current && appointment.client_response === 'reschedule_requested') {
    return language === 'ru' ? 'Клиент просит перенос' : 'Client requested reschedule';
  }
  return language === 'ru' ? 'Ожидаем подтверждения клиента' : 'Awaiting client confirmation';
}
