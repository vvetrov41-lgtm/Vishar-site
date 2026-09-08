import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';

export function DetailBackLink({ to, sectionLabel }: { to: string; sectionLabel: string }) {
  const { language } = useLanguage();
  const label = language === 'ru' ? `Назад: ${sectionLabel}` : `Back to ${sectionLabel}`;

  return (
    <nav aria-label={language === 'ru' ? 'Навигация по записи' : 'Record navigation'}>
      <div className="actions" style={{ marginTop: 0, marginBottom: 12 }}>
        <Link
          to={to}
          className="badge"
          style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', paddingInline: 14 }}
        >
          ← {label}
        </Link>
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
        <strong>{language === 'ru' ? 'Мастер записи недоступен' : 'Record artist unavailable'}</strong>
      </div>
    );
  }

  return (
    <div
      className={mismatch ? 'notice warn' : 'notice'}
      role="status"
      style={{ marginBottom: 12, paddingBlock: mismatch ? undefined : 9 }}
    >
      <strong style={{ color: mismatch ? undefined : 'var(--text)' }}>
        {language === 'ru' ? 'Мастер' : 'Artist'}: {artist.display_name}
      </strong>
      {mismatch ? (
        <>
          <span style={{ display: 'block', marginTop: 4 }}>
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
      ) : null}
    </div>
  );
}