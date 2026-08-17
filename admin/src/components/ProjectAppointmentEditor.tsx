import { useEffect, useState } from 'react';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Appointment, AppointmentConflict, AppointmentType } from '../lib/appointment-api';

const DURATION_MINUTES: Record<AppointmentType, number[]> = {
  tattoo_session: [180, 300, 420],
  in_person_consultation: [15, 20, 30],
  video_consultation: [15, 20, 30],
  touch_up: [60, 120, 180],
};

export function ProjectAppointmentEditor({
  appointment,
  disabled = false,
  onSaved,
}: {
  appointment: Appointment;
  disabled?: boolean;
  onSaved: () => void;
}) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState(() => toDateTimeLocal(new Date(appointment.start_at)));
  const [endAt, setEndAt] = useState(() => toDateTimeLocal(new Date(appointment.end_at)));
  const [note, setNote] = useState('');
  const [conflicts, setConflicts] = useState<AppointmentConflict[]>([]);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setStartAt(toDateTimeLocal(new Date(appointment.start_at)));
    setEndAt(toDateTimeLocal(new Date(appointment.end_at)));
    setNote('');
    setConflicts([]);
    setError(null);
  }, [appointment.start_at, appointment.end_at, open]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const startIso = inputToIso(startAt);
    const endIso = inputToIso(endAt);

    if (!startIso || !endIso || endIso <= startIso) {
      setConflicts([]);
      setCheckingConflicts(false);
      return undefined;
    }

    setCheckingConflicts(true);
    api.listAppointmentConflicts({
      artistId: appointment.artist_id,
      startAt: startIso,
      endAt: endIso,
      excludeAppointmentId: appointment.id,
    })
      .then((rows) => { if (!cancelled) setConflicts(rows); })
      .catch(() => { if (!cancelled) setConflicts([]); })
      .finally(() => { if (!cancelled) setCheckingConflicts(false); });

    return () => { cancelled = true; };
  }, [api, appointment.artist_id, appointment.id, open, startAt, endAt]);

  const startIso = inputToIso(startAt);
  const endIso = inputToIso(endAt);
  const timeValid = Boolean(startIso && endIso && endIso > startIso);
  const timeChanged = Boolean(
    startIso && endIso
    && (startIso !== appointment.start_at || endIso !== appointment.end_at)
  );
  const hasNote = note.trim().length > 0;

  async function save() {
    if (!startIso || !endIso || !timeValid || (!timeChanged && !hasNote)) return;
    setSaving(true);
    setError(null);
    try {
      if (timeChanged) {
        await api.rescheduleAppointment({
          appointmentId: appointment.id,
          startAt: startIso,
          endAt: endIso,
        });
      }
      if (hasNote) {
        await api.createAppointmentInternalNote(appointment.id, note.trim());
      }
      setOpen(false);
      setNote('');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setSaving(false);
    }
  }

  function applyDuration(minutes: number) {
    if (!startAt) return;
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) return;
    setEndAt(toDateTimeLocal(new Date(start.getTime() + minutes * 60_000)));
  }

  return (
    <>
      <div className="actions">
        <button
          type="button"
          disabled={disabled || saving}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? copy.close : copy.edit}
        </button>
      </div>

      {open ? (
        <div className="notice" style={{ marginTop: 12 }}>
          <div className="field-row">
            <div>
              <label htmlFor={`project-appointment-start-${appointment.id}`}>{copy.start}</label>
              <input
                id={`project-appointment-start-${appointment.id}`}
                type="datetime-local"
                value={startAt}
                onChange={(event) => setStartAt(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`project-appointment-end-${appointment.id}`}>{copy.end}</label>
              <input
                id={`project-appointment-end-${appointment.id}`}
                type="datetime-local"
                value={endAt}
                onChange={(event) => setEndAt(event.target.value)}
              />
            </div>
          </div>

          <div className="actions" aria-label={copy.duration}>
            {DURATION_MINUTES[appointment.appointment_type].map((minutes) => (
              <button
                key={minutes}
                type="button"
                disabled={saving || !startAt}
                onClick={() => applyDuration(minutes)}
              >
                {durationShortcut(minutes, language)}
              </button>
            ))}
          </div>

          <label htmlFor={`project-appointment-note-${appointment.id}`}>{copy.note}</label>
          <textarea
            id={`project-appointment-note-${appointment.id}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={8000}
            placeholder={copy.notePlaceholder}
          />
          <p className="meta">{copy.noteHint}</p>

          {appointment.notes ? (
            <div className="meta" style={{ whiteSpace: 'pre-wrap' }}>
              {copy.existingNote}: {appointment.notes}
            </div>
          ) : null}

          {checkingConflicts ? <p className="notice">{copy.checking}</p> : null}
          {conflicts.length > 0 ? (
            <p className="notice warn" role="status">
              {copy.conflicts(conflicts.length, formatDateTime(conflicts[0].start_at, language))}
            </p>
          ) : null}
          {!timeValid ? <p className="notice warn">{copy.invalidTime}</p> : null}
          {error ? <p className="notice warn" role="alert">{error}</p> : null}

          <div className="actions">
            <button
              type="button"
              disabled={saving || !timeValid || (!timeChanged && !hasNote)}
              onClick={() => { void save(); }}
            >
              {saving ? copy.saving : copy.save}
            </button>
            <button type="button" disabled={saving} onClick={() => setOpen(false)}>{copy.cancel}</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function inputToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toDateTimeLocal(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function durationShortcut(minutes: number, language: Language): string {
  if (minutes < 60) return language === 'ru' ? `${minutes} мин` : `${minutes} min`;
  return language === 'ru' ? `${minutes / 60} ч` : `${minutes / 60} h`;
}

const COPY = {
  en: {
    edit: 'Edit appointment',
    close: 'Close editor',
    start: 'Start',
    end: 'End',
    duration: 'Duration shortcuts',
    note: 'Add internal note',
    notePlaceholder: 'Optional note for the CRM team',
    noteHint: 'The note stays in CRM. It is not copied to Google Calendar.',
    existingNote: 'Existing appointment note',
    checking: 'Checking the artist schedule…',
    conflicts: (count: number, date: string) => `Conflicting active appointments: ${count}. The first starts ${date}. You can still save if the overlap is intentional.`,
    invalidTime: 'Choose a valid start and a later end time.',
    save: 'Save changes',
    saving: 'Saving…',
    cancel: 'Cancel editing',
    failed: 'Could not update the appointment.',
  },
  ru: {
    edit: 'Редактировать запись',
    close: 'Закрыть редактирование',
    start: 'Начало',
    end: 'Окончание',
    duration: 'Быстрый выбор длительности',
    note: 'Добавить внутреннюю заметку',
    notePlaceholder: 'Необязательная заметка для CRM',
    noteHint: 'Заметка останется только в CRM и не попадёт в Google Calendar.',
    existingNote: 'Текущая заметка записи',
    checking: 'Проверяем расписание мастера…',
    conflicts: (count: number, date: string) => `Пересекающихся активных записей: ${count}. Первая начинается ${date}. Если пересечение намеренное, изменения всё равно можно сохранить.`,
    invalidTime: 'Выбери корректное начало и более позднее окончание.',
    save: 'Сохранить изменения',
    saving: 'Сохраняем…',
    cancel: 'Отменить редактирование',
    failed: 'Не удалось изменить запись.',
  },
} as const;
