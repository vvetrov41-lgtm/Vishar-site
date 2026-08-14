import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { LoadingState } from '../components/StateViews';
import type {
  AvailabilityBlock,
  AvailabilityBlockKind,
  AvailabilityBlockInput,
} from '../lib/availability-api';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { can } from '../lib/permissions';
import { useApi, useSession } from '../lib/session';

interface BlockFormState {
  blockKind: AvailabilityBlockKind;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startDateTime: string;
  endDateTime: string;
  note: string;
}

const KIND_OPTIONS: AvailabilityBlockKind[] = ['day_off', 'holiday', 'personal', 'other'];

export function AvailabilityPage() {
  const api = useApi();
  const { profile } = useSession();
  const { language } = useLanguage();
  const {
    artists,
    selectedArtistId,
    loading: artistScopeLoading,
  } = useArtistScope();
  const [blocks, setBlocks] = useState<AvailabilityBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BlockFormState>(() => defaultForm());
  const mayManage = can(profile?.role, 'manageSessions');
  const copy = pageCopy(language);
  const selectedArtist = useMemo(
    () => artists.find((artist) => artist.id === selectedArtistId) ?? null,
    [artists, selectedArtistId]
  );

  useEffect(() => {
    setEditingId(null);
    setForm(defaultForm());
    setError(null);
    if (!selectedArtistId) {
      setBlocks([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const to = new Date();
    to.setDate(to.getDate() + 365);

    void api.listAvailabilityBlocks({
      artistId: selectedArtistId,
      from: from.toISOString(),
      to: to.toISOString(),
    }).then((rows) => {
      if (!cancelled) setBlocks(rows);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : copy.loadBlocksError);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [api, selectedArtistId, copy.loadBlocksError]);

  async function loadBlocks() {
    if (!selectedArtistId) return;
    setLoading(true);
    setError(null);
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const to = new Date();
    to.setDate(to.getDate() + 365);
    try {
      const rows = await api.listAvailabilityBlocks({
        artistId: selectedArtistId,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      setBlocks(rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.loadBlocksError);
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedArtistId || !selectedArtist || !mayManage) return;

    let input: AvailabilityBlockInput;
    try {
      input = formToInput(
        selectedArtistId,
        selectedArtist.timezone,
        form,
        copy.invalidRange
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.invalidRange);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await api.updateAvailabilityBlock(editingId, {
          blockKind: input.blockKind,
          startAt: input.startAt,
          endAt: input.endAt,
          isAllDay: input.isAllDay,
          note: input.note,
        });
      } else {
        await api.createAvailabilityBlock(input);
      }
      setEditingId(null);
      setForm(defaultForm());
      await loadBlocks();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.saveError);
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(block: AvailabilityBlock) {
    if (!selectedArtist) return;
    setEditingId(block.block_id);
    setForm(blockToForm(block, selectedArtist.timezone));
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function cancelBlock(block: AvailabilityBlock) {
    if (!mayManage) return;
    if (!window.confirm(copy.cancelConfirm)) return;
    setSaving(true);
    setError(null);
    try {
      await api.cancelAvailabilityBlock(block.block_id);
      if (editingId === block.block_id) {
        setEditingId(null);
        setForm(defaultForm());
      }
      await loadBlocks();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.cancelError);
    } finally {
      setSaving(false);
    }
  }

  if (artistScopeLoading) return <LoadingState label={copy.loading} />;

  if (!selectedArtistId) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{copy.title}</h2>
            <p>{copy.subtitle}</p>
          </div>
        </div>
        <div className="notice">{copy.chooseOneArtist}</div>
      </section>
    );
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{copy.title}</h2>
            <p>{copy.subtitle}</p>
            {selectedArtist ? <p><strong>{selectedArtist.display_name}</strong></p> : null}
          </div>
        </div>

        {error ? <div className="notice warn" role="alert">{error}</div> : null}

        {!mayManage ? (
          <div className="notice">{copy.readOnly}</div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <div className="form-grid">
              <label className="field">
                <span>{copy.type}</span>
                <select
                  value={form.blockKind}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    blockKind: event.target.value as AvailabilityBlockKind,
                  }))}
                >
                  {KIND_OPTIONS.map((kind) => (
                    <option key={kind} value={kind}>{kindLabel(kind, language)}</option>
                  ))}
                </select>
              </label>

              <label className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  onChange={(event) => setForm((current) => ({ ...current, allDay: event.target.checked }))}
                />
                <span>{copy.allDay}</span>
              </label>
            </div>

            {form.allDay ? (
              <div className="form-grid">
                <label className="field">
                  <span>{copy.firstDay}</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))}
                    required
                  />
                </label>
                <label className="field">
                  <span>{copy.lastDay}</span>
                  <input
                    type="date"
                    value={form.endDate}
                    min={form.startDate}
                    onChange={(event) => setForm((current) => ({ ...current, endDate: event.target.value }))}
                    required
                  />
                </label>
              </div>
            ) : (
              <div className="form-grid">
                <label className="field">
                  <span>{copy.starts}</span>
                  <input
                    type="datetime-local"
                    value={form.startDateTime}
                    onChange={(event) => setForm((current) => ({ ...current, startDateTime: event.target.value }))}
                    required
                  />
                </label>
                <label className="field">
                  <span>{copy.ends}</span>
                  <input
                    type="datetime-local"
                    value={form.endDateTime}
                    onChange={(event) => setForm((current) => ({ ...current, endDateTime: event.target.value }))}
                    required
                  />
                </label>
              </div>
            )}

            <label className="field">
              <span>{copy.note}</span>
              <input
                value={form.note}
                maxLength={500}
                placeholder={copy.notePlaceholder}
                onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              />
            </label>

            <div className="actions">
              <button type="submit" disabled={saving || !selectedArtist}>
                {editingId ? copy.saveChanges : copy.blockTime}
              </button>
              {editingId ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={saving}
                  onClick={() => {
                    setEditingId(null);
                    setForm(defaultForm());
                    setError(null);
                  }}
                >
                  {copy.stopEditing}
                </button>
              ) : null}
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{copy.upcoming}</h2>
            <p>{selectedArtist?.display_name ?? copy.chooseArtist}</p>
          </div>
        </div>

        {loading ? <LoadingState label={copy.loadingBlocks} /> : null}
        {!loading && blocks.length === 0 ? <div className="notice">{copy.none}</div> : null}

        <div className="stack">
          {blocks.map((block) => (
            <article key={block.block_id} className="panel" style={{ margin: 0 }}>
              <div className="panel-heading">
                <div>
                  <strong>{kindLabel(block.block_kind, language)}</strong>
                  <p>{formatBlockRange(block, language, selectedArtist?.timezone ?? 'UTC')}</p>
                  {block.note ? <p>{block.note}</p> : null}
                </div>
                {mayManage ? (
                  <div className="actions">
                    <button type="button" className="secondary" disabled={saving} onClick={() => beginEdit(block)}>
                      {copy.edit}
                    </button>
                    <button type="button" className="secondary" disabled={saving} onClick={() => { void cancelBlock(block); }}>
                      {copy.remove}
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function defaultForm(): BlockFormState {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setHours(17, 0, 0, 0);
  const day = localDate(start);
  return {
    blockKind: 'day_off',
    allDay: true,
    startDate: day,
    endDate: day,
    startDateTime: localDateTime(start),
    endDateTime: localDateTime(end),
    note: '',
  };
}

function formToInput(
  artistId: string,
  timeZone: string,
  form: BlockFormState,
  invalidRangeMessage: string
): AvailabilityBlockInput {
  let startAt: string;
  let endAt: string;

  if (form.allDay) {
    if (!form.startDate || !form.endDate || form.endDate < form.startDate) {
      throw new Error(invalidRangeMessage);
    }
    startAt = zonedLocalIso(`${form.startDate}T00:00`, timeZone, invalidRangeMessage);
    endAt = zonedLocalIso(`${addDateDays(form.endDate, 1)}T00:00`, timeZone, invalidRangeMessage);
  } else {
    startAt = zonedLocalIso(form.startDateTime, timeZone, invalidRangeMessage);
    endAt = zonedLocalIso(form.endDateTime, timeZone, invalidRangeMessage);
  }

  if (new Date(endAt) <= new Date(startAt)) throw new Error(invalidRangeMessage);

  return {
    artistId,
    blockKind: form.blockKind,
    startAt,
    endAt,
    isAllDay: form.allDay,
    note: form.note.trim() || null,
  };
}

function blockToForm(block: AvailabilityBlock, timeZone: string): BlockFormState {
  const start = new Date(block.start_at);
  const end = new Date(block.end_at);
  const inclusiveEnd = new Date(end.getTime() - 1);
  return {
    blockKind: block.block_kind,
    allDay: block.is_all_day,
    startDate: dateInputInZone(start, timeZone),
    endDate: dateInputInZone(inclusiveEnd, timeZone),
    startDateTime: dateTimeInputInZone(start, timeZone),
    endDateTime: dateTimeInputInZone(end, timeZone),
    note: block.note ?? '',
  };
}

function zonedLocalIso(value: string, timeZone: string, errorMessage: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(errorMessage);
  const desired = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  if (
    desired.month < 1 || desired.month > 12 || desired.day < 1 || desired.day > 31
    || desired.hour > 23 || desired.minute > 59
  ) throw new Error(errorMessage);

  const desiredEpoch = Date.UTC(
    desired.year, desired.month - 1, desired.day, desired.hour, desired.minute
  );
  let instant = desiredEpoch;
  for (let pass = 0; pass < 3; pass += 1) {
    const observed = zonedParts(new Date(instant), timeZone);
    const observedEpoch = Date.UTC(
      observed.year, observed.month - 1, observed.day, observed.hour, observed.minute
    );
    instant += desiredEpoch - observedEpoch;
  }
  const final = zonedParts(new Date(instant), timeZone);
  if (
    final.year !== desired.year || final.month !== desired.month || final.day !== desired.day
    || final.hour !== desired.hour || final.minute !== desired.minute
  ) throw new Error(errorMessage);
  return new Date(instant).toISOString();
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: value('year'), month: value('month'), day: value('day'),
    hour: value('hour'), minute: value('minute'),
  };
}

function addDateDays(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateInputInZone(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function dateTimeInputInZone(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}T${parts.hour.toString().padStart(2, '0')}:${parts.minute.toString().padStart(2, '0')}`;
}

function localDate(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function localDateTime(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function kindLabel(kind: AvailabilityBlockKind, language: 'en' | 'ru'): string {
  const labels = {
    en: { day_off: 'Day off', holiday: 'Holiday', personal: 'Personal', other: 'Other' },
    ru: { day_off: 'Выходной', holiday: 'Отпуск', personal: 'Личное', other: 'Другое' },
  } as const;
  return labels[language][kind];
}

function formatBlockRange(
  block: AvailabilityBlock,
  language: 'en' | 'ru',
  timeZone: string
): string {
  const locale = language === 'ru' ? 'ru-RU' : 'en-GB';
  const start = new Date(block.start_at);
  const end = new Date(block.end_at);
  if (block.is_all_day) {
    const inclusiveEnd = new Date(end.getTime() - 1);
    const startText = start.toLocaleDateString(locale, { dateStyle: 'medium', timeZone });
    const endText = inclusiveEnd.toLocaleDateString(locale, { dateStyle: 'medium', timeZone });
    return startText === endText ? startText : `${startText} - ${endText}`;
  }
  return `${start.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone })} - ${end.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone })}`;
}

function pageCopy(language: 'en' | 'ru') {
  return language === 'ru'
    ? {
        title: 'Доступность и выходные',
        subtitle: 'Заблокированное здесь время нельзя использовать для активных записей. База данных остаётся источником истины.',
        type: 'Причина', allDay: 'Весь день', firstDay: 'Первый день', lastDay: 'Последний день',
        starts: 'Начало', ends: 'Окончание', note: 'Заметка', notePlaceholder: 'Необязательно, до 500 символов',
        blockTime: 'Заблокировать время', saveChanges: 'Сохранить изменения', stopEditing: 'Отменить редактирование',
        upcoming: 'Предстоящие блокировки', chooseArtist: 'Выберите мастера', none: 'Предстоящих блокировок нет.',
        edit: 'Изменить', remove: 'Убрать', readOnly: 'У вас есть доступ к просмотру, но нет права управлять расписанием.',
        loading: 'Загрузка доступности...', loadingBlocks: 'Загрузка блокировок...',
        loadBlocksError: 'Не удалось загрузить доступность.', saveError: 'Не удалось сохранить блокировку.',
        cancelError: 'Не удалось убрать блокировку.', invalidRange: 'Проверьте даты и время.',
        chooseOneArtist: 'Выберите одного мастера в верхнем фильтре. Блокировка времени всегда относится только к одному мастеру.',
        cancelConfirm: 'Убрать эту блокировку времени? После этого интервал снова можно будет использовать для записей.',
      }
    : {
        title: 'Availability and time off',
        subtitle: 'Time blocked here cannot be used for active appointments. The database remains authoritative.',
        type: 'Reason', allDay: 'All day', firstDay: 'First day', lastDay: 'Last day',
        starts: 'Starts', ends: 'Ends', note: 'Note', notePlaceholder: 'Optional, up to 500 characters',
        blockTime: 'Block time', saveChanges: 'Save changes', stopEditing: 'Stop editing',
        upcoming: 'Upcoming blocks', chooseArtist: 'Choose an artist', none: 'No upcoming availability blocks.',
        edit: 'Edit', remove: 'Remove', readOnly: 'You can view availability but do not have schedule-management access.',
        loading: 'Loading availability...', loadingBlocks: 'Loading blocks...',
        loadBlocksError: 'Could not load availability.', saveError: 'Could not save that block.',
        cancelError: 'Could not remove that block.', invalidRange: 'Check the dates and times.',
        chooseOneArtist: 'Choose one artist in the top filter. A time-off block always belongs to exactly one artist.',
        cancelConfirm: 'Remove this time-off block? The interval will become schedulable again.',
      };
}
