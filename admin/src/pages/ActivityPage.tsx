import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { operationalLabel } from '../lib/operational-labels';
import type { ActivityEntry } from '../lib/types';
import { useArtistScope } from '../lib/artist-scope';

export function ActivityPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const [eventType, setEventType] = useState('');
  const { selectedArtistId } = useArtistScope();

  const { data, loading, error, reload } = useAsync<ActivityEntry[]>(
    () => api.listActivity({ artistId: selectedArtistId ?? undefined }),
    [api, selectedArtistId]
  );

  const eventTypes = Array.from(new Set((data ?? []).map((entry) => entry.event_type)))
    .sort((left, right) => operationalLabel(language, 'event', left)
      .localeCompare(operationalLabel(language, 'event', right), language));
  const visibleEntries = eventType
    ? (data ?? []).filter((entry) => entry.event_type === eventType)
    : (data ?? []);

  return (
    <>
      <div className="card">
        <label htmlFor="event-type">{t('activity.filter')}</label>
        <select
          id="event-type"
          value={eventType}
          onChange={(event) => setEventType(event.target.value)}
        >
          <option value="">{language === 'ru' ? 'Все события' : 'All events'}</option>
          {eventTypes.map((type) => (
            <option key={type} value={type}>
              {operationalLabel(language, 'event', type)}
            </option>
          ))}
        </select>
        <p className="notice" style={{ marginTop: 12 }}>{t('activity.notice')}</p>
      </div>

      {loading ? <LoadingState label={t('activity.loading')} /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {!loading && !error && visibleEntries.length === 0 ? (
        <EmptyState title={t('activity.noMatch')} />
      ) : null}

      {!loading && !error && visibleEntries.length > 0 ? (
        <ul className="timeline">
          {visibleEntries.map((entry) => (
            <li key={entry.id}>
              <div title={entry.event_type}>
                {operationalLabel(language, 'event', entry.event_type)}
              </div>
              <div className="when">
                {formatDateTime(entry.occurred_at, language)} · {label('actor', entry.actor_kind)}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
