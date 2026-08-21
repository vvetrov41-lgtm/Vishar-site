import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import {
  bookingSourcePublicUrl,
  type BookingSource,
  type BookingSourceKind,
} from '../lib/platform-api';
import { useApi, useSession } from '../lib/session';

export function BookingSourcesPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { artists, selectedArtistId } = useArtistScope();
  const { language } = useLanguage();
  const [scopeArtistId, setScopeArtistId] = useState<string | null>(selectedArtistId);
  const [kind, setKind] = useState<BookingSourceKind>('hosted');
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [createArtistId, setCreateArtistId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const manageableArtists = useMemo(() => {
    if (profile?.role === 'owner') return artists;
    const allowed = new Set(
      memberships
        .filter((membership) => membership.is_active && membership.can_manage_integrations)
        .map((membership) => membership.artist_id),
    );
    return artists.filter((artist) => allowed.has(artist.id));
  }, [artists, memberships, profile?.role]);

  // A persisted Artist selector may outlive a membership downgrade. Never send
  // that stale id to the manage-only RPC even for one render: collapse it to
  // the all-manageable view before the request is constructed.
  const effectiveScopeArtistId = scopeArtistId
    && manageableArtists.some((artist) => artist.id === scopeArtistId)
    ? scopeArtistId
    : null;

  useEffect(() => {
    const selectedIsManageable = selectedArtistId !== null
      && manageableArtists.some((artist) => artist.id === selectedArtistId);
    setScopeArtistId(selectedIsManageable ? selectedArtistId : null);
  }, [manageableArtists, selectedArtistId]);

  useEffect(() => {
    if (effectiveScopeArtistId) {
      setCreateArtistId(effectiveScopeArtistId);
      return;
    }
    if (manageableArtists.length === 1) {
      setCreateArtistId(manageableArtists[0].id);
      return;
    }
    setCreateArtistId((current) => (
      manageableArtists.some((artist) => artist.id === current) ? current : ''
    ));
  }, [effectiveScopeArtistId, manageableArtists]);

  const state = useAsync(
    () => manageableArtists.length > 0
      ? api.listBookingSources(effectiveScopeArtistId ?? undefined)
      : Promise.resolve([]),
    [api, manageableArtists.length, effectiveScopeArtistId],
  );

  if (manageableArtists.length === 0) {
    return (
      <EmptyState
        title={language === 'ru' ? 'Нет доступа к настройке форм' : 'No access to form settings'}
        hint={language === 'ru'
          ? 'У вас нет права управлять источниками заявок ни для одного доступного мастера.'
          : 'You cannot manage booking sources for any of your accessible artists.'}
      />
    );
  }

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const artistNames = new Map(artists.map((artist) => [artist.id, artist.display_name]));
  const sources = state.data ?? [];

  async function createSource(event: FormEvent) {
    event.preventDefault();
    setCreateError(null);
    if (!createArtistId) {
      setCreateError(language === 'ru' ? 'Сначала выберите мастера.' : 'Choose an artist first.');
      return;
    }
    if (!label.trim()) {
      setCreateError(language === 'ru' ? 'Введите название.' : 'Enter a label.');
      return;
    }
    if (kind === 'external' && !origin.trim()) {
      setCreateError(language === 'ru' ? 'Укажите HTTPS origin сайта.' : 'Enter the website HTTPS origin.');
      return;
    }

    setCreating(true);
    try {
      await api.createBookingSource({
        artistId: createArtistId,
        sourceKind: kind,
        displayLabel: label.trim(),
        allowedOrigin: kind === 'external' ? origin.trim() : null,
      });
      setLabel('');
      setOrigin('');
      state.reload();
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Could not create that source.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="stack">
      <div className="notice" role="note">
        <strong style={{ display: 'block' }}>
          {language === 'ru' ? 'Формы и сайты' : 'Forms and websites'}
        </strong>
        <span>
          {language === 'ru'
            ? 'Hosted-форма работает на Vishar. External подключает существующий сайт по его точному HTTPS origin. Новые источники создаются выключенными.'
            : 'Hosted forms run on Vishar. External connects an existing website by its exact HTTPS origin. New sources are created disabled.'}
        </span>
      </div>

      {manageableArtists.length > 1 ? (
        <label>
          <span>{language === 'ru' ? 'Показать источники' : 'Show sources for'}</span>
          <select
            aria-label={language === 'ru' ? 'Фильтр источников по мастеру' : 'Booking source artist filter'}
            value={effectiveScopeArtistId ?? ''}
            onChange={(event) => setScopeArtistId(event.target.value || null)}
          >
            <option value="">{language === 'ru' ? 'Все доступные для управления' : 'All manageable artists'}</option>
            {manageableArtists.map((artist) => (
              <option key={artist.id} value={artist.id}>{artist.display_name}</option>
            ))}
          </select>
        </label>
      ) : null}

      <Section title={language === 'ru' ? 'Добавить источник' : 'Add source'}>
        <form className="card stack" onSubmit={createSource}>
          {manageableArtists.length > 1 ? (
            <label>
              <span>{language === 'ru' ? 'Мастер' : 'Artist'}</span>
              <select
                aria-label={language === 'ru' ? 'Мастер для новой формы' : 'Artist for new source'}
                value={createArtistId}
                onChange={(event) => setCreateArtistId(event.target.value)}
                required
              >
                <option value="">{language === 'ru' ? 'Выберите мастера' : 'Choose artist'}</option>
                {manageableArtists.map((artist) => (
                  <option key={artist.id} value={artist.id}>{artist.display_name}</option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            <span>{language === 'ru' ? 'Тип' : 'Type'}</span>
            <select
              aria-label={language === 'ru' ? 'Тип источника' : 'Source type'}
              value={kind}
              onChange={(event) => setKind(event.target.value as BookingSourceKind)}
            >
              <option value="hosted">{language === 'ru' ? 'Hosted форма Vishar' : 'Vishar hosted form'}</option>
              <option value="external">{language === 'ru' ? 'External сайт' : 'External website'}</option>
            </select>
          </label>

          <label>
            <span>{language === 'ru' ? 'Название' : 'Label'}</span>
            <input
              aria-label={language === 'ru' ? 'Название источника' : 'Source label'}
              value={label}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={language === 'ru' ? 'Например, London enquiry' : 'For example, London enquiry'}
              required
            />
          </label>

          {kind === 'external' ? (
            <label>
              <span>{language === 'ru' ? 'HTTPS origin сайта' : 'Website HTTPS origin'}</span>
              <input
                aria-label={language === 'ru' ? 'HTTPS origin сайта' : 'Website HTTPS origin'}
                type="url"
                inputMode="url"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="https://example.com"
                required
              />
              <small className="muted">
                {language === 'ru'
                  ? 'Только origin, без пути, query или #fragment.'
                  : 'Origin only, without a path, query or #fragment.'}
              </small>
            </label>
          ) : null}

          {createError ? <div className="notice warn" role="alert">{createError}</div> : null}
          <div className="actions">
            <button type="submit" disabled={creating}>
              {creating
                ? (language === 'ru' ? 'Создание…' : 'Creating…')
                : (language === 'ru' ? 'Создать выключенным' : 'Create disabled')}
            </button>
          </div>
        </form>
      </Section>

      <Section title={language === 'ru' ? 'Подключённые источники' : 'Connected sources'}>
        {sources.length === 0 ? (
          <EmptyState
            title={language === 'ru' ? 'Источников пока нет' : 'No sources yet'}
            hint={language === 'ru'
              ? 'Создайте hosted-форму или подключите существующий сайт.'
              : 'Create a hosted form or connect an existing website.'}
          />
        ) : (
          <ul className="card-list">
            {sources.map((source) => (
              <BookingSourceCard
                key={source.id}
                source={source}
                artistName={artistNames.get(source.artist_id) ?? ''}
                language={language}
                onChanged={state.reload}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function BookingSourceCard({
  source,
  artistName,
  language,
  onChanged,
}: {
  source: BookingSource;
  artistName: string;
  language: 'en' | 'ru';
  onChanged: () => void;
}) {
  const api = useApi();
  const [label, setLabel] = useState(source.display_label);
  const [origin, setOrigin] = useState(source.allowed_origin ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = bookingSourcePublicUrl(source);

  useEffect(() => {
    setLabel(source.display_label);
    setOrigin(source.allowed_origin ?? '');
  }, [source.allowed_origin, source.display_label]);

  async function save(isActive = source.is_active) {
    setBusy(true);
    setError(null);
    try {
      await api.updateBookingSource({
        bookingSourceId: source.id,
        displayLabel: label.trim(),
        allowedOrigin: source.source_kind === 'external' ? origin.trim() : null,
        isActive,
      });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update that source.');
    } finally {
      setBusy(false);
    }
  }

  function copyTarget() {
    if (!target || !navigator.clipboard) return;
    void navigator.clipboard.writeText(target).catch(() => undefined);
  }

  return (
    <li className="card">
      <div className="card-header">
        <strong>{source.display_label}</strong>
        <span className={`badge ${source.is_active ? 'badge-connected' : ''}`}>
          {source.is_active
            ? (language === 'ru' ? 'Активен' : 'Active')
            : (language === 'ru' ? 'Выключен' : 'Disabled')}
        </span>
      </div>

      {artistName ? <p className="muted">{artistName}</p> : null}
      <p className="muted">
        {source.source_kind === 'hosted'
          ? (language === 'ru' ? 'Hosted форма Vishar' : 'Vishar hosted form')
          : (language === 'ru' ? 'External сайт' : 'External website')}
      </p>

      <label>
        <span>{language === 'ru' ? 'Название' : 'Label'}</span>
        <input aria-label={`${source.display_label} label`} value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} />
      </label>

      {source.source_kind === 'external' ? (
        <label>
          <span>{language === 'ru' ? 'Разрешённый origin' : 'Allowed origin'}</span>
          <input
            aria-label={`${source.display_label} origin`}
            type="url"
            inputMode="url"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </label>
      ) : null}

      {target ? (
        <label>
          <span>
            {source.source_kind === 'hosted'
              ? (language === 'ru' ? 'Ссылка на форму' : 'Form URL')
              : (language === 'ru' ? 'Endpoint для формы сайта' : 'Website form endpoint')}
          </span>
          <input readOnly value={target} aria-label={`${source.display_label} public URL`} />
        </label>
      ) : null}

      {source.source_kind === 'external' ? (
        <p className="muted">
          {language === 'ru'
            ? 'Форма на этом origin должна отправлять multipart POST на endpoint выше. UUID в URL является публичным selector, Artist определяется сервером.'
            : 'The form on this origin must send multipart POST to the endpoint above. The URL UUID is a public selector; the server determines the Artist.'}
        </p>
      ) : null}

      {error ? <div className="notice warn" role="alert">{error}</div> : null}

      <div className="actions">
        <button type="button" disabled={busy || !label.trim()} onClick={() => { void save(); }}>
          {language === 'ru' ? 'Сохранить' : 'Save'}
        </button>
        <button type="button" disabled={busy || !label.trim()} onClick={() => { void save(!source.is_active); }}>
          {source.is_active
            ? (language === 'ru' ? 'Выключить' : 'Disable')
            : (language === 'ru' ? 'Включить' : 'Enable')}
        </button>
        {target ? (
          <button type="button" onClick={copyTarget}>
            {language === 'ru' ? 'Копировать ссылку' : 'Copy URL'}
          </button>
        ) : null}
        {source.source_kind === 'hosted' && target ? (
          <a href={target} target="_blank" rel="noreferrer">
            {language === 'ru' ? 'Открыть форму' : 'Open form'}
          </a>
        ) : null}
      </div>
    </li>
  );
}
