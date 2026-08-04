import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { ACTIVITY_EVENT_TYPES, operationalLabel } from '../lib/operational-labels';
import type { ActivityEntry } from '../lib/types';
import { useArtistScope } from '../lib/artist-scope';

export function ActivityPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const [eventType, setEventType] = useState('');
  const { selectedArtistId } = useArtistScope();

  const { data, loading, error, reload } = useAsync<ActivityEntry[]>(
    () => api.listActivity({
      eventType: eventType || undefined,
      artistId: selectedArtistId ?? undefined,
    }),
    [api, eventType, selectedArtistId]
  );

  const eventTypes = [...ACTIVITY_EVENT_TYPES].sort((left, right) =>
    operationalLabel(language, 'event', left)
      .localeCompare(operationalLabel(language, 'event', right), language)
  );

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
      {!loading && !error && data && data.length === 0 ? (
        <EmptyState title={t('activity.noMatch')} />
      ) : null}

      {!loading && !error && data && data.length > 0 ? (
        <ul className="timeline">
          {data.map((entry) => (
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
