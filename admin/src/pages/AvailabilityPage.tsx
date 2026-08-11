import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { can } from '../lib/permissions';
import { useApi, useSession } from '../lib/session';
import { useLanguage } from '../lib/i18n';
import type {
  AvailabilityBlock,
  AvailabilityBlockKind,
  AvailabilityBlockInput,
} from '../lib/availability-api';
import { LoadingState } from '../components/StateViews';

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
  const [artists, setArtists] = useState<{ id: string; display_name: string }[]>([]);
  const [artistId, setArtistId] = useState('');
  const [blocks, setBlocks] = useState<AvailabilityBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BlockFormState>(() => defaultForm());
  const mayManage = can(profile?.role, 'manageSessions');
  const copy = pageCopy(language);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.listAccessibleArtists()
      .then((rows) => {
        if (cancelled) return;
        setArtists(rows);
        setArtistId((current) => current || rows[0]?.id || '');
      })
      .catch(() => {
        if (!cancelled) setError(copy.loadArtistsError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, copy.loadArtistsError]);

  useEffect(() => {
    if (!artistId) {
      setBlocks([]);
      return;
    }
    void loadBlocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistId]);

  const selectedArtist = useMemo(
    () => artists.find((artist) => artist.id === artistId) ?? null,
    [artists, artistId]
  );

  async function loadBlocks() {
    if (!artistId) return;
    setLoading(true);
    setError(null);
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const to = new Date();
    to.setDate(to.getDate() + 365);
    try {
      const rows = await api.listAvailabilityBlocks({
        artistId,
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
    if (!artistId || !mayManage) return;

    let input: AvailabilityBlockInput;
    try {
      input = formToInput(artistId, form);
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
    setEditingId(block.block_id);
    setForm(blockToForm(block));
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

  if (loading && artists.length === 0) return <LoadingState label={copy.loading} />;

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{copy.title}</h2>
            <p>{copy.subtitle}</p>
          </div>
        </div>

        {error ? <div className="notice warn" role="alert">{error}</div> : null}

        <label className="field" style={{ maxWidth: 420 }}>
          <span>{copy.artist}</span>
          <select value={artistId} onChange={(event) => setArtistId(event.target.value)}>
            {artists.map((artist) => (
              <option key={artist.id} value={artist.id}>{artist.display_name}</option>
            ))}
          </select>
        </label>

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
              <button type="submit" disabled={saving || !artistId}>
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
            <p>{selectedArtist ? selectedArtist.display_name : copy.chooseArtist}</p>
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
                  <p>{formatBlockRange(block, language)}</p>
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

function formToInput(artistId: string, form: BlockFormState): AvailabilityBlockInput {
  let start: Date;
  let end: Date;
  if (form.allDay) {
    if (!form.startDate || !form.endDate || form.endDate < form.startDate) {
      throw new Error('Choose a valid first and last day.');
    }
    start = new Date(`${form.startDate}T00:00:00`);
    end = new Date(`${form.endDate}T00:00:00`);
    end.setDate(end.getDate() + 1);
  } else {
    start = new Date(form.startDateTime);
    end = new Date(form.endDateTime);
  }
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error('The end of time off must be after the start.');
  }
  return {
    artistId,
    blockKind: form.blockKind,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    isAllDay: form.allDay,
    note: form.note.trim() || null,
  };
}

function blockToForm(block: AvailabilityBlock): BlockFormState {
  const start = new Date(block.start_at);
  const end = new Date(block.end_at);
  const inclusiveEnd = new Date(end.getTime() - 1);
  return {
    blockKind: block.block_kind,
    allDay: block.is_all_day,
    startDate: localDate(start),
    endDate: localDate(inclusiveEnd),
    startDateTime: localDateTime(start),
    endDateTime: localDateTime(end),
    note: block.note ?? '',
  };
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

function formatBlockRange(block: AvailabilityBlock, language: 'en' | 'ru'): string {
  const locale = language === 'ru' ? 'ru-RU' : 'en-GB';
  const start = new Date(block.start_at);
  const end = new Date(block.end_at);
  if (block.is_all_day) {
    const inclusiveEnd = new Date(end.getTime() - 1);
    const startText = start.toLocaleDateString(locale, { dateStyle: 'medium' });
    const endText = inclusiveEnd.toLocaleDateString(locale, { dateStyle: 'medium' });
    return startText === endText ? startText : `${startText} - ${endText}`;
  }
  return `${start.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })} - ${end.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function pageCopy(language: 'en' | 'ru') {
  return language === 'ru'
    ? {
        title: 'Доступность и выходные',
        subtitle: 'Заблокированное здесь время нельзя использовать для активных записей. База данных остаётся источником истины.',
        artist: 'Мастер', type: 'Причина', allDay: 'Весь день', firstDay: 'Первый день', lastDay: 'Последний день',
        starts: 'Начало', ends: 'Окончание', note: 'Заметка', notePlaceholder: 'Необязательно, до 500 символов',
        blockTime: 'Заблокировать время', saveChanges: 'Сохранить изменения', stopEditing: 'Отменить редактирование',
        upcoming: 'Предстоящие блокировки', chooseArtist: 'Выберите мастера', none: 'Предстоящих блокировок нет.',
        edit: 'Изменить', remove: 'Убрать', readOnly: 'У вас есть доступ к просмотру, но нет права управлять расписанием этого уровня.',
        loading: 'Загрузка доступности...', loadingBlocks: 'Загрузка блокировок...',
        loadArtistsError: 'Не удалось загрузить список мастеров.', loadBlocksError: 'Не удалось загрузить доступность.',
        saveError: 'Не удалось сохранить блокировку.', cancelError: 'Не удалось убрать блокировку.', invalidRange: 'Проверьте даты и время.',
        cancelConfirm: 'Убрать эту блокировку времени? После этого интервал снова можно будет использовать для записей.',
      }
    : {
        title: 'Availability and time off',
        subtitle: 'Time blocked here cannot be used for active appointments. The database remains authoritative.',
        artist: 'Artist', type: 'Reason', allDay: 'All day', firstDay: 'First day', lastDay: 'Last day',
        starts: 'Starts', ends: 'Ends', note: 'Note', notePlaceholder: 'Optional, up to 500 characters',
        blockTime: 'Block time', saveChanges: 'Save changes', stopEditing: 'Stop editing',
        upcoming: 'Upcoming blocks', chooseArtist: 'Choose an artist', none: 'No upcoming availability blocks.',
        edit: 'Edit', remove: 'Remove', readOnly: 'You can view availability but do not have schedule-management access.',
        loading: 'Loading availability...', loadingBlocks: 'Loading blocks...',
        loadArtistsError: 'Could not load artists.', loadBlocksError: 'Could not load availability.',
        saveError: 'Could not save that block.', cancelError: 'Could not remove that block.', invalidRange: 'Check the dates and times.',
        cancelConfirm: 'Remove this time-off block? The interval will become schedulable again.',
      };
}