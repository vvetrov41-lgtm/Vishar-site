import { useState } from 'react';
import { calendarSyncLabel } from '../lib/calendar-sync';
import { formatDateTime } from '../lib/format';
import type { Language } from '../lib/i18n';
import { Link } from '../lib/router';
import type { Client, Enquiry, Project, SessionStatus } from '../lib/types';
import type { Appointment, AppointmentClientResponse, AppointmentType } from '../lib/appointment-api';

export function AppointmentRow({
  appointment,
  client,
  enquiry,
  project,
  language,
  statusLabel,
  paymentLabel,
  mayManage,
  changing,
  onStatus,
  onReschedule,
}: {
  appointment: Appointment;
  client: Client | null;
  enquiry: Enquiry | null;
  project: Project | null;
  language: Language;
  statusLabel: string;
  paymentLabel: string;
  mayManage: boolean;
  changing: boolean;
  onStatus: (status: SessionStatus) => void;
  onReschedule: (startAt: string, endAt: string) => Promise<void>;
}) {
  const copy = COPY[language];
  const appointmentName = `${typeLabel(appointment.appointment_type, language)} · ${formatDateTime(appointment.start_at, language)}`;
  const isActive = ['draft', 'proposed', 'confirmed'].includes(appointment.status);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [nextStartAt, setNextStartAt] = useState(toDateTimeLocal(new Date(appointment.start_at)));
  const [nextEndAt, setNextEndAt] = useState(toDateTimeLocal(new Date(appointment.end_at)));
  const nextStartIso = inputToIso(nextStartAt);
  const nextEndIso = inputToIso(nextEndAt);
  const rescheduleValid = Boolean(nextStartIso && nextEndIso && nextEndIso > nextStartIso);

  return (
    <div className="row">
      <div className="title">{formatDateTime(appointment.start_at, language)}</div>
      <div className="meta">
        <span className="badge">{typeLabel(appointment.appointment_type, language)}</span>{' '}
        <span className={appointment.status === 'confirmed' ? 'badge ok' : 'badge'}>{statusLabel}</span>{' '}
        {appointment.client_response ? (
          <span className={appointment.client_response === 'reschedule_requested' ? 'badge warn' : 'badge ok'}>
            {clientResponseLabel(appointment.client_response, language)}
            {appointment.client_response_at ? ` · ${formatDateTime(appointment.client_response_at, language)}` : ''}
          </span>
        ) : null}{' '}
        <span className="badge">{durationValue(appointment.duration_hours, language)}</span>{' '}
        <span className="badge">{paymentLabel}</span>{' '}
        <span className={appointment.calendar_sync_status === 'failed' ? 'badge warn' : 'badge'}>
          {copy.calendar}: {calendarSyncLabel(appointment, language)}
        </span>
      </div>
      <div className="meta" style={{ marginTop: 8 }}>
        {client ? (
          <Link to={`/clients/${client.id}`} className="badge">{copy.client}: {client.full_name}</Link>
        ) : null}{' '}
        {enquiry ? (
          <Link to={`/enquiries/${enquiry.id}`} className="badge">{copy.enquiry}: {enquiry.reference_number}</Link>
        ) : null}{' '}
        {project ? (
          <Link to={`/projects/${project.id}`} className="badge">{copy.project}: {project.title}</Link>
        ) : (
          <span className="badge">{copy.noProject}</span>
        )}
      </div>
      {mayManage && isActive ? (
        <>
          <div className="actions">
            <button type="button" disabled={changing} aria-expanded={rescheduleOpen} onClick={() => setRescheduleOpen((open) => !open)}>{copy.reschedule}</button>
            {['draft', 'proposed'].includes(appointment.status) ? (
              <button type="button" disabled={changing} aria-label={`${copy.confirm}: ${appointmentName}`} onClick={() => onStatus('confirmed')}>{copy.confirm}</button>
            ) : null}
            {appointment.status === 'confirmed' ? (
              <>
                <button type="button" disabled={changing} aria-label={`${copy.markCompleted}: ${appointmentName}`} onClick={() => onStatus('completed')}>{copy.markCompleted}</button>
                <button type="button" disabled={changing} aria-label={`${copy.markNoShow}: ${appointmentName}`} onClick={() => onStatus('no_show')}>{copy.markNoShow}</button>
              </>
            ) : null}
            <button type="button" className="danger" disabled={changing} aria-label={`${copy.cancel}: ${appointmentName}`} onClick={() => onStatus('cancelled')}>{copy.cancel}</button>
          </div>
          {rescheduleOpen ? (
            <div className="notice" style={{ marginTop: 12 }}>
              <div className="form-grid">
                <label><span>{copy.newStart}</span><input type="datetime-local" value={nextStartAt} onChange={(event) => setNextStartAt(event.target.value)} /></label>
                <label><span>{copy.newEnd}</span><input type="datetime-local" value={nextEndAt} onChange={(event) => setNextEndAt(event.target.value)} /></label>
              </div>
              <div className="actions">
                <button type="button" disabled={changing || !rescheduleValid} onClick={() => { if (!nextStartIso || !nextEndIso) return; void onReschedule(nextStartIso, nextEndIso).then(() => setRescheduleOpen(false)); }}>{changing ? copy.saving : copy.saveReschedule}</button>
                <button type="button" disabled={changing} onClick={() => setRescheduleOpen(false)}>{copy.goBack}</button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function typeLabel(type: AppointmentType, language: Language): string { return TYPE_LABELS[language][type]; }
export function clientResponseLabel(response: AppointmentClientResponse, language: Language): string {
  const labels: Record<Language, Record<AppointmentClientResponse, string>> = { en: { attendance_confirmed: 'Client confirmed', reschedule_requested: 'Client requested reschedule' }, ru: { attendance_confirmed: 'Клиент подтвердил', reschedule_requested: 'Клиент просит перенос' } };
  return labels[language][response];
}
function durationShortcut(minutes: number, language: Language): string { if (minutes < 60) return language === 'ru' ? `${minutes} мин` : `${minutes} min`; const hours = minutes / 60; return language === 'ru' ? `${hours} ч` : `${hours} h`; }
function durationValue(hours: number | null, language: Language): string { if (hours === null) return '-'; if (hours < 1) return durationShortcut(Math.round(hours * 60), language); return language === 'ru' ? `${hours} ч` : `${hours} h`; }
function inputToIso(value: string): string | null { if (!value) return null; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(); }
function toDateTimeLocal(value: Date): string { const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
const TYPE_LABELS: Record<Language, Record<AppointmentType, string>> = { en: { tattoo_session: 'Tattoo session', in_person_consultation: 'In-person consultation', video_consultation: 'Video consultation', touch_up: 'Touch-up' }, ru: { tattoo_session: 'Тату-сеанс', in_person_consultation: 'Очная консультация', video_consultation: 'Видеоконсультация', touch_up: 'Коррекция' } };
const COPY: Record<Language, Record<string, string>> = { en: { project: 'Project', enquiry: 'Enquiry', client: 'Client', noProject: 'No project', reschedule: 'Reschedule', newStart: 'New start', newEnd: 'New end', saveReschedule: 'Save new time', goBack: 'Go back', saving: 'Saving…', confirm: 'Confirm', markCompleted: 'Mark completed', markNoShow: 'Mark no-show', cancel: 'Cancel', calendar: 'Calendar' }, ru: { project: 'Проект', enquiry: 'Заявка', client: 'Клиент', noProject: 'Без проекта', reschedule: 'Перенести', newStart: 'Новое начало', newEnd: 'Новое окончание', saveReschedule: 'Сохранить новое время', goBack: 'Назад', saving: 'Сохраняем…', confirm: 'Подтвердить', markCompleted: 'Завершить', markNoShow: 'Не пришёл', cancel: 'Отменить', calendar: 'Календарь' } };
