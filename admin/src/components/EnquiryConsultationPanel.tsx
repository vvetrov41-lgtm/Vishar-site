import { useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { AppointmentType } from '../lib/appointment-api';
import type { Enquiry } from '../lib/types';

const CONSULTATION_TYPES: AppointmentType[] = [
  'in_person_consultation',
  'video_consultation',
];

const DURATIONS = [15, 20, 30];

export function EnquiryConsultationPanel({
  enquiry,
  onChanged,
}: {
  enquiry: Enquiry;
  onChanged: () => void;
}) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [appointmentType, setAppointmentType] = useState<AppointmentType>('in_person_consultation');
  const [startAt, setStartAt] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function schedule() {
    const start = new Date(startAt);
    if (!startAt || Number.isNaN(start.getTime())) {
      setError(copy.invalidStart);
      return;
    }

    const end = new Date(start.getTime() + durationMinutes * 60_000);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.scheduleAppointment({
        artistId: enquiry.artist_id,
        clientId: enquiry.client_id,
        appointmentType,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        status: 'proposed',
        enquiryId: enquiry.id,
        projectId: null,
        notes: notes.trim() || null,
      });
      setStartAt('');
      setNotes('');
      setNotice(copy.created);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: '0.9rem' }}>{copy.title}</h3>
      <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0 0 10px' }}>
        {copy.hint}
      </p>
      <div className="form-grid">
        <label>
          <span>{copy.type}</span>
          <select
            value={appointmentType}
            disabled={busy}
            onChange={(event) => setAppointmentType(event.target.value as AppointmentType)}
          >
            {CONSULTATION_TYPES.map((type) => (
              <option key={type} value={type}>{typeLabel(type, language)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{copy.start}</span>
          <input
            type="datetime-local"
            value={startAt}
            disabled={busy}
            onChange={(event) => setStartAt(event.target.value)}
          />
        </label>
        <label>
          <span>{copy.duration}</span>
          <select
            value={durationMinutes}
            disabled={busy}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
          >
            {DURATIONS.map((minutes) => (
              <option key={minutes} value={minutes}>{copy.minutes(minutes)}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span>{copy.notes}</span>
        <textarea
          value={notes}
          maxLength={8000}
          disabled={busy}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={busy || !startAt}
          onClick={() => { void schedule(); }}
        >
          {busy ? copy.saving : copy.schedule}
        </button>
      </div>
      {notice ? <p className="notice ok" role="status">{notice}</p> : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}
    </div>
  );
}

function typeLabel(type: AppointmentType, language: 'en' | 'ru') {
  if (language === 'ru') {
    return type === 'video_consultation' ? 'Видеоконсультация' : 'Очная консультация';
  }
  return type === 'video_consultation' ? 'Video consultation' : 'In-person consultation';
}

const COPY = {
  en: {
    title: 'Schedule a consultation',
    hint: 'Create a consultation directly from this enquiry. A project is not created until you decide to proceed with the tattoo.',
    type: 'Consultation type',
    start: 'Date and time',
    duration: 'Duration',
    notes: 'Notes (optional)',
    minutes: (value: number) => `${value} min`,
    schedule: 'Schedule consultation',
    saving: 'Scheduling…',
    created: 'Consultation scheduled and linked to this enquiry.',
    invalidStart: 'Choose a valid consultation date and time.',
    failed: 'Could not schedule that consultation.',
  },
  ru: {
    title: 'Записать на консультацию',
    hint: 'Создай консультацию прямо из заявки. Проект появится только тогда, когда решишь продолжить работу над татуировкой.',
    type: 'Тип консультации',
    start: 'Дата и время',
    duration: 'Длительность',
    notes: 'Заметка (необязательно)',
    minutes: (value: number) => `${value} мин`,
    schedule: 'Записать на консультацию',
    saving: 'Сохраняю…',
    created: 'Консультация создана и привязана к этой заявке.',
    invalidStart: 'Укажи корректные дату и время консультации.',
    failed: 'Не удалось создать консультацию.',
  },
} as const;
