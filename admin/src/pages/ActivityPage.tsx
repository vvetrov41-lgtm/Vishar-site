import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { ActivityEntry } from '../lib/types';

export function ActivityPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const [eventType, setEventType] = useState('');

  const { data, loading, error, reload } = useAsync<ActivityEntry[]>(
    () => api.listActivity({ eventType: eventType || undefined }),
    [api, eventType]
  );

  return (
    <>
      <div className="card">
        <label htmlFor="event-type">{t('activity.filter')}</label>
        <input
          id="event-type" type="search"
          value={eventType} onChange={(event) => setEventType(event.target.value)}
          placeholder="enquiry.status_changed"
        />
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
              <div>{label('event', entry.event_type)}</div>
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
