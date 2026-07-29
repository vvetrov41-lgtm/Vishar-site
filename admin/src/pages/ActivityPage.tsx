import { useState } from 'react';
import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import type { ActivityEntry } from '../lib/types';

export function ActivityPage() {
  const api = useApi();
  const [eventType, setEventType] = useState('');

  const { data, loading, error, reload } = useAsync<ActivityEntry[]>(
    () => api.listActivity({ eventType: eventType || undefined }),
    [api, eventType]
  );

  return (
    <>
      <div className="card">
        <label htmlFor="event-type">Filter by event type</label>
        <input
          id="event-type" type="search"
          value={eventType} onChange={(event) => setEventType(event.target.value)}
          placeholder="enquiry.status_changed"
        />
        <p className="notice" style={{ marginTop: 12 }}>
          The activity log is append-only. There is no edit or delete control here
          because the database refuses both, for every role.
        </p>
      </div>

      {loading ? <LoadingState label="Loading activity…" /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {!loading && !error && data && data.length === 0 ? (
        <EmptyState title="No matching activity" />
      ) : null}

      {!loading && !error && data && data.length > 0 ? (
        <ul className="timeline">
          {data.map((entry) => (
            <li key={entry.id}>
              <div>{entry.event_type}</div>
              <div className="when">
                {formatDateTime(entry.occurred_at)} · {entry.actor_kind}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
