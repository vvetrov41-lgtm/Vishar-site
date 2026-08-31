// Where the artist's booking boundaries are edited.
//
// These values decide what Smart Booking offers and, through the same policy,
// what the database will accept. They are stored per artist (0120) rather than
// compiled into the interface, so changing when the studio works is an
// operator action, not a developer one.
//
// Deliberately small. This is not a shift-management product: it is the four
// boundaries that scheduling actually depends on, the habitual start times,
// and the one policy switch that makes this studio different from a salon.

import { useState, type FormEvent } from 'react';
import { useAsync } from './AsyncData';
import { ErrorState, LoadingState } from './StateViews';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { SchedulingPreferences } from '../lib/scheduling-api';

/** Starts an operator can toggle. Any of them may be habitual; none is forced. */
const START_CHOICES = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'];

export function SchedulingPreferencesPanel({
  artistId,
  canEdit,
}: {
  artistId: string;
  canEdit: boolean;
}) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];

  const { data, loading, error, reload } = useAsync<SchedulingPreferences>(
    () => api.getSchedulingPreferences(artistId),
    [api, artistId],
  );

  const [draft, setDraft] = useState<SchedulingPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const current = draft ?? data;

  function update(patch: Partial<SchedulingPreferences>) {
    setDraft({ ...current, ...patch });
    setNotice(null);
  }

  function toggleStart(value: string) {
    const starts = current.tattoo_preferred_starts.includes(value)
      ? current.tattoo_preferred_starts.filter((entry) => entry !== value)
      : [...current.tattoo_preferred_starts, value].sort();
    // At least one habitual start has to survive, because the search ranks by
    // them; the database refuses an empty list anyway.
    if (starts.length === 0) return;
    update({ tattoo_preferred_starts: starts });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaveError(null);
    setNotice(null);
    setSaving(true);
    try {
      const saved = await api.setSchedulingPreferences({
        artistId,
        tattooEarliestStart: current.tattoo_earliest_start,
        tattooLatestFinish: current.tattoo_latest_finish,
        tattooPreferredStarts: current.tattoo_preferred_starts,
        consultationEarliestStart: current.consultation_earliest_start,
        consultationLatestFinish: current.consultation_latest_finish,
        consultationDuringTattoo: current.consultation_during_tattoo,
        maxConcurrentConsultations: current.max_concurrent_consultations,
      });
      setDraft(null);
      setNotice(copy.saved);
      reload();
      return saved;
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : copy.saveFailed);
      return null;
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="scheduling-settings" onSubmit={(event) => { void save(event); }}>
      <p className="meta">{copy.intro}</p>
      {!data.is_stored ? <p className="meta">{copy.usingDefaults}</p> : null}

      <div className="form-grid">
        <label>
          <span>{copy.tattooEarliest}</span>
          <input
            type="time"
            value={current.tattoo_earliest_start}
            disabled={!canEdit}
            onChange={(event) => update({ tattoo_earliest_start: event.target.value })}
          />
        </label>
        <label>
          <span>{copy.tattooLatest}</span>
          <input
            type="time"
            value={current.tattoo_latest_finish}
            disabled={!canEdit}
            onChange={(event) => update({ tattoo_latest_finish: event.target.value })}
          />
        </label>
      </div>

      <fieldset className="booking-hours">
        <legend>{copy.usualStarts}</legend>
        <p className="meta">{copy.usualStartsHint}</p>
        <div className="scheduling-starts">
          {START_CHOICES.map((value) => (
            <button
              key={value}
              type="button"
              disabled={!canEdit}
              aria-pressed={current.tattoo_preferred_starts.includes(value)}
              className={current.tattoo_preferred_starts.includes(value) ? 'selected' : undefined}
              onClick={() => toggleStart(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="form-grid">
        <label>
          <span>{copy.consultationEarliest}</span>
          <input
            type="time"
            value={current.consultation_earliest_start}
            disabled={!canEdit}
            onChange={(event) => update({ consultation_earliest_start: event.target.value })}
          />
        </label>
        <label>
          <span>{copy.consultationLatest}</span>
          <input
            type="time"
            value={current.consultation_latest_finish}
            disabled={!canEdit}
            onChange={(event) => update({ consultation_latest_finish: event.target.value })}
          />
        </label>
      </div>

      <label className="conflict-acknowledgement">
        <input
          type="checkbox"
          checked={current.consultation_during_tattoo}
          disabled={!canEdit}
          onChange={(event) => update({ consultation_during_tattoo: event.target.checked })}
        />
        <span>{copy.duringTattoo}</span>
      </label>
      <p className="meta">{copy.duringTattooHint}</p>

      <label>
        <span>{copy.maxConcurrent}</span>
        <input
          type="number"
          min={1}
          max={4}
          value={current.max_concurrent_consultations}
          disabled={!canEdit}
          onChange={(event) => update({
            max_concurrent_consultations: Math.min(4, Math.max(1, Number(event.target.value) || 1)),
          })}
        />
      </label>

      {saveError ? <p className="notice warn" role="alert">{saveError}</p> : null}
      {notice ? <p className="notice ok" role="status">{notice}</p> : null}

      {canEdit ? (
        <div className="actions">
          <button type="submit" className="primary" disabled={saving || !draft}>
            {saving ? copy.saving : copy.save}
          </button>
          {draft ? (
            <button type="button" disabled={saving} onClick={() => { setDraft(null); setNotice(null); }}>
              {copy.discard}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="notice" role="status">{copy.readOnly}</p>
      )}
    </form>
  );
}

const COPY = {
  en: {
    loading: 'Loading scheduling preferences…',
    intro: 'These decide the times Smart Booking offers, and the times the CRM will accept.',
    usingDefaults: 'Nothing has been saved yet, so the studio defaults are in use.',
    tattooEarliest: 'Tattoo sessions start no earlier than',
    tattooLatest: 'Tattoo sessions finish by',
    usualStarts: 'Usual tattoo start times',
    usualStartsHint: 'Offered first when searching. Other start times inside the window are still offered, just after these.',
    consultationEarliest: 'Consultations start no earlier than',
    consultationLatest: 'Consultations finish by',
    duringTattoo: 'Consultations may happen during a tattoo session',
    duringTattooHint: 'On, a consultation can be booked before, between, or while a session is running. Off, a tattoo session blocks consultations for its whole length.',
    maxConcurrent: 'Consultations that may overlap each other',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved. Smart Booking uses these from the next search.',
    saveFailed: 'Could not save the scheduling preferences.',
    discard: 'Discard changes',
    readOnly: 'You can see these, but changing them needs appointment management for this artist.',
  },
  ru: {
    loading: 'Загружаем настройки расписания…',
    intro: 'Они определяют, какое время предлагает подбор и какое время примет CRM.',
    usingDefaults: 'Пока ничего не сохранено, поэтому действуют настройки студии по умолчанию.',
    tattooEarliest: 'Тату-сеансы не раньше',
    tattooLatest: 'Тату-сеансы заканчиваются до',
    usualStarts: 'Обычное время начала тату-сеанса',
    usualStartsHint: 'Предлагается в первую очередь. Другое время внутри окна тоже предлагается, но после этого.',
    consultationEarliest: 'Консультации не раньше',
    consultationLatest: 'Консультации заканчиваются до',
    duringTattoo: 'Консультации можно проводить во время тату-сеанса',
    duringTattooHint: 'Включено — консультацию можно записать до, между или во время сеанса. Выключено — тату-сеанс закрывает всё своё время для консультаций.',
    maxConcurrent: 'Сколько консультаций могут пересекаться',
    save: 'Сохранить',
    saving: 'Сохраняем…',
    saved: 'Сохранено. Подбор времени учтёт это со следующего поиска.',
    saveFailed: 'Не удалось сохранить настройки расписания.',
    discard: 'Отменить изменения',
    readOnly: 'Вы можете их видеть, но для изменения нужны права управления записями этого мастера.',
  },
} as const;
