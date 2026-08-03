import { useArtistScope } from '../lib/artist-scope';
import { resolveArtistNames } from '../lib/client-artist-relationships';
import { useLanguage } from '../lib/i18n';

export function ArtistRelationship({
  artistIds,
  showEmpty = false,
}: {
  artistIds: string[];
  showEmpty?: boolean;
}) {
  const { artists } = useArtistScope();
  const { t } = useLanguage();
  const names = resolveArtistNames(artistIds, artists);
  const values = names.length > 0 ? names : showEmpty ? ['—'] : [];

  if (values.length === 0) return null;

  const label = `${t('artistScope.label')}: ${values.join(', ')}`;

  return (
    <span
      aria-label={label}
      style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}
    >
      {values.map((name) => (
        <span key={name} className="badge" aria-hidden="true">
          {t('artistScope.label')}: {name}
        </span>
      ))}
    </span>
  );
}
