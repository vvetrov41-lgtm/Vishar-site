import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { CrmSession } from '../lib/types';

export function SessionsPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const { data, loading, error, reload } = useAsync<CrmSession[]>(() => api.listSessions(), [api]);

  if (loading) return <LoadingState label={t('sessions.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) {
    return <EmptyState title={t('sessions.noSessions')} hint={t('sessions.noSessionsHint')} />;
  }

  const now = Date.now();
  const upcoming = data.filter((session) => new Date(session.start_at).getTime() >= now);
  const past = data.filter((session) => new Date(session.start_at).getTime() < now).reverse();

  return (
    <>
      <Section title={t('sessions.upcoming')}>
        {upcoming.length === 0 ? <EmptyState title={t('sessions.nothingUpcoming')} /> : (
          <div className="list">
            {upcoming.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                language={language}
                t={t}
                label={label}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title={t('sessions.past')}>
        {past.length === 0 ? <EmptyState title={t('sessions.noPast')} /> : (
          <div className="list">
            {past.slice(0, 30).map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                language={language}
                t={t}
                label={label}
              />
            ))}
          </div>
        )}
      </Section>

      <p className="notice">{t('sessions.calendarNotice')}</p>
    </>
  );
}

function SessionRow({
  session,
  language,
  t,
  label,
}: {
  session: CrmSession;
  language: 'en' | 'ru';
  t: (key: string, params?: Record<string, string | number>) => string;
  label: (group: string, value: string | null | undefined) => string;
}) {
  return (
    <div className="row">
      <div className="title">{formatDateTime(session.start_at, language)}</div>
      <div className="meta">
        <span className={session.status === 'confirmed' ? 'badge ok' : 'badge'}>
          {label('sessionStatus', session.status)}
        </span>{' '}
        <span className="badge">{session.duration_hours ?? '—'} {t('common.hoursShort')}</span>{' '}
        <span className="badge">{label('paymentStatus', session.payment_status)}</span>{' '}
        <span className="badge">
          {t('common.calendar')}: {session.calendar_event_id ? t('common.linked') : t('common.notConnected')}
        </span>
      </div>
    </div>
  );
}
