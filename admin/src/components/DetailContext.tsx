import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';

export function DetailBackLink({ to, sectionLabel }: { to: string; sectionLabel: string }) {
  const { language } = useLanguage();
  const label = language === 'ru' ? `Назад: ${sectionLabel}` : `Back to ${sectionLabel}`;

  return (
    <nav aria-label={language === 'ru' ? 'Навигация по записи' : 'Record navigation'}>
      <div className="actions" style={{ marginTop: 0, marginBottom: 12 }}>
        <Link to={to} className="badge">← {label}</Link>
      </div>
    </nav>
  );
}

export function RecordArtistContext({ artistId }: { artistId: string }) {
  const { artists, selectedArtistId, setSelectedArtistId } = useArtistScope();
  const { language } = useLanguage();
  const artist = artists.find((candidate) => candidate.id === artistId) ?? null;
  const selectedArtist = selectedArtistId
    ? artists.find((candidate) => candidate.id === selectedArtistId) ?? null
    : null;
  const mismatch = Boolean(selectedArtistId && selectedArtistId !== artistId);

  if (!artist) {
    return (
      <div className="notice warn" role="status" style={{ marginBottom: 12 }}>
        <strong style={{ display: 'block' }}>
          {language === 'ru' ? 'Мастер записи недоступен в текущем списке' : 'Record artist is not in the current list'}
        </strong>
        <span>
          {language === 'ru'
            ? 'Запись остаётся основной точкой истины; доступ по-прежнему контролируется базой данных.'
            : 'The record remains authoritative; database access controls still apply.'}
        </span>
      </div>
    );
  }

  return (
    <div className={mismatch ? 'notice warn' : 'notice'} role="status" style={{ marginBottom: 12 }}>
      <strong style={{ display: 'block', color: mismatch ? undefined : 'var(--text)' }}>
        {language === 'ru' ? 'Мастер' : 'Artist'}: {artist.display_name}
      </strong>
      {mismatch ? (
        <>
          <span>
            {language === 'ru'
              ? `Фильтр CRM сейчас установлен на ${selectedArtist?.display_name ?? 'другого мастера'}.`
              : `The CRM filter is currently set to ${selectedArtist?.display_name ?? 'another artist'}.`}
          </span>
          <div className="actions">
            <button type="button" onClick={() => setSelectedArtistId(artist.id)}>
              {language === 'ru' ? `Переключить на ${artist.display_name}` : `Switch to ${artist.display_name}`}
            </button>
          </div>
        </>
      ) : (
        <span>
          {language === 'ru'
            ? 'Контекст записи совпадает с текущим фильтром или открыт список всех мастеров.'
            : 'The record matches the current filter, or all assigned artists are selected.'}
        </span>
      )}
    </div>
  );
}
