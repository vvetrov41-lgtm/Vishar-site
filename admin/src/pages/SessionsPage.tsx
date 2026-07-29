import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import type { CrmSession } from '../lib/types';

export function SessionsPage() {
  const api = useApi();
  const { data, loading, error, reload } = useAsync<CrmSession[]>(() => api.listSessions(), [api]);

  if (loading) return <LoadingState label="Loading sessions…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) {
    return <EmptyState title="No sessions yet" hint="Sessions are planned from inside a project." />;
  }

  const now = Date.now();
  const upcoming = data.filter((session) => new Date(session.start_at).getTime() >= now);
  const past = data.filter((session) => new Date(session.start_at).getTime() < now).reverse();

  return (
    <>
      <Section title="Upcoming">
        {upcoming.length === 0 ? <EmptyState title="Nothing scheduled ahead" /> : (
          <div className="list">{upcoming.map((session) => <SessionRow key={session.id} session={session} />)}</div>
        )}
      </Section>

      <Section title="Past">
        {past.length === 0 ? <EmptyState title="No past sessions" /> : (
          <div className="list">{past.slice(0, 30).map((session) => <SessionRow key={session.id} session={session} />)}</div>
        )}
      </Section>

      <p className="notice">
        Calendar status is a placeholder. Google Calendar is not connected, so no
        session here has been written to a calendar.
      </p>
    </>
  );
}

function SessionRow({ session }: { session: CrmSession }) {
  return (
    <div className="row">
      <div className="title">{formatDateTime(session.start_at)}</div>
      <div className="meta">
        <span className={session.status === 'confirmed' ? 'badge ok' : 'badge'}>{session.status}</span>{' '}
        <span className="badge">{session.duration_hours ?? '—'} h</span>{' '}
        <span className="badge">{session.payment_status.replace(/_/g, ' ')}</span>{' '}
        <span className="badge">Calendar: {session.calendar_event_id ? 'linked' : 'not connected'}</span>
      </div>
    </div>
  );
}
