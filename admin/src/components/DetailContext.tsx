import type { ReactNode } from 'react';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { useRouter } from '../lib/router';

/**
 * Back to wherever the operator came from (keeping that list's filters and
 * scroll position); on a direct link with no earlier CRM screen, to `to`.
 */
export function DetailBackLink({ to, sectionLabel, extra }: { to: string; sectionLabel: string; extra?: ReactNode }) {
  const { language } = useLanguage();
  const { canGoBack, goBack } = useRouter();
  const label = canGoBack
    ? (language === 'ru' ? 'Назад' : 'Back')
    : (language === 'ru' ? `Назад: ${sectionLabel}` : `Back to ${sectionLabel}`);

  return (
    <nav aria-label={language === 'ru' ? 'Навигация по записи' : 'Record navigation'}>
      <div className="actions" style={{ marginTop: 0, marginBottom: 12 }}>
        <a
          href={`#${to}`}
          className="badge"
          style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', paddingInline: 14 }}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            goBack(to);
          }}
        >
          ← {label}
        </a>
        {extra}
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
/** Inline variant of DetailBackLink for compact headers. */
export function BackButton({ to, fallbackLabel, className }: { to: string; fallbackLabel: string; className?: string }) {
  const { language } = useLanguage();
  const { canGoBack, goBack } = useRouter();
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        goBack(to);
      }}
    >
      {canGoBack ? (language === 'ru' ? '← Назад' : '← Back') : fallbackLabel}
    </a>
  );
}

/**
 * One header row for a record: Back, and the record's artist as a chip.
 * Only when the CRM filter points at another artist (or the artist is
 * unavailable) does the full notice with its switch action appear below.
 */
export function DetailHeader({ to, sectionLabel, artistId }: { to: string; sectionLabel: string; artistId: string }) {
  const { artists, selectedArtistId } = useArtistScope();
  const { language } = useLanguage();
  const artist = artists.find((candidate) => candidate.id === artistId) ?? null;
  const mismatch = Boolean(selectedArtistId && selectedArtistId !== artistId);
  const inline = artist && !mismatch;
  return (
    <>
      <DetailBackLink
        to={to}
        sectionLabel={sectionLabel}
        extra={inline ? (
          <span className="badge record-artist-chip" role="status">
            {language === 'ru' ? 'Мастер' : 'Artist'}: {artist.display_name}
          </span>
        ) : null}
      />
      {inline ? null : <RecordArtistContext artistId={artistId} />}
    </>
  );
}
