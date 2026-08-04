import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { Link } from '../lib/router';
import { can } from '../lib/permissions';
import { formatDateTime, relativeDue } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { groupFailedJobs, operationalLabel } from '../lib/operational-labels';
import type { ActivityEntry, CrmSession, Enquiry, FollowUp, OutboxJob } from '../lib/types';
import { useArtistScope } from '../lib/artist-scope';

interface DashboardData {
  enquiries: Enquiry[];
  followUps: FollowUp[];
  sessions: CrmSession[];
  activity: ActivityEntry[];
  failedJobs: OutboxJob[];
}

export function DashboardPage() {
  const api = useApi();
  const { profile } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;
  const { selectedArtistId } = useArtistScope();

  const { data, loading, error, reload } = useAsync<DashboardData>(async () => {
    // Each of these is fetched independently and any one may come back empty
    // because of row level security rather than because there is nothing there.
    // The role checks below decide what to *ask* for; the database decides what
    // comes back.
    const [enquiries, followUps, sessions, activity, failedJobs] = await Promise.all([
      api.listEnquiries({ artistId: selectedArtistId ?? undefined }),
      api.listFollowUps({ open: true, artistId: selectedArtistId ?? undefined }),
      api.listSessions(undefined, selectedArtistId ?? undefined),
      can(role, 'viewActivity')
        ? api.listActivity({ artistId: selectedArtistId ?? undefined })
        : Promise.resolve([]),
      can(role, 'viewIntegrationJobs')
        ? api.listFailedJobs(selectedArtistId ?? undefined)
        : Promise.resolve([]),
    ]);
    return { enquiries, followUps, sessions, activity, failedJobs };
  }, [api, role, selectedArtistId]);

  if (loading) return <LoadingState label={t('dashboard.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t('dashboard.nothing')} />;

  const now = new Date();
  const newEnquiries = data.enquiries.filter((enquiry) => enquiry.status === 'new');
  const unassigned = data.enquiries.filter((enquiry) => !enquiry.assigned_to);
  const waiting = data.enquiries.filter((enquiry) => enquiry.status === 'waiting_for_client');
  const overdue = data.followUps.filter((followUp) => new Date(followUp.due_at) < now);
  const upcoming = data.sessions
    .filter((session) => session.status === 'confirmed' && new Date(session.start_at) >= now)
    .slice(0, 5);
  const failedJobGroups = groupFailedJobs(data.failedJobs);

  return (
    <>
      <Section title={t('dashboard.enquiries')}>
        <div className="dashboard-metrics">
          <Metric label={t('dashboard.new')} value={newEnquiries.length} />
          <Metric label={t('dashboard.unassigned')} value={unassigned.length} />
          <Metric label={t('dashboard.waiting')} value={waiting.length} />
        </div>
        <div className="actions">
          <Link to="/enquiries" className="badge">{t('dashboard.openQueue')}</Link>
        </div>
      </Section>

      <Section title={t('dashboard.upcomingSessions')}>
        {upcoming.length === 0 ? (
          <EmptyState
            compact
            title={t('dashboard.noConfirmedSessions')}
            hint={t('dashboard.onlyConfirmedSessions')}
          />
        ) : (
          <div className="list">
            {upcoming.map((session) => (
              <Link key={session.id} to={`/projects/${session.project_id}`} className="row">
                <div className="title">{formatDateTime(session.start_at, language)}</div>
                <div className="meta">
                  <span className="badge ok">{label('sessionStatus', 'confirmed')}</span>{' '}
                  <span className="badge">{session.duration_hours ?? '—'} {t('common.hoursShort')}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('dashboard.overdueFollowUps')}>
        {overdue.length === 0 ? (
          <EmptyState
            compact
            title={t('dashboard.nothingOverdue')}
            hint={t('dashboard.followUpsAppear')}
          />
        ) : (
          <div className="list">
            {overdue.slice(0, 6).map((followUp) => {
              const due = relativeDue(followUp.due_at, now, language);
              const target = followUpTarget(followUp);
              const content = (
                <>
                  <div className="title">{followUp.subject}</div>
                  <div className="meta">
                    <span className={due.overdue ? 'badge danger' : 'badge'}>{due.label}</span>
                  </div>
                </>
              );

              return target ? (
                <Link key={followUp.id} to={target} className="row">{content}</Link>
              ) : (
                <div key={followUp.id} className="row">{content}</div>
              );
            })}
          </div>
        )}
      </Section>

      {can(role, 'viewIntegrationJobs') ? (
        <Section title={t('dashboard.failedJobs')}>
          {failedJobGroups.length === 0 ? (
            <EmptyState
              compact
              title={t('dashboard.nothingFailed')}
              hint={t('dashboard.queueFailureHint')}
            />
          ) : (
            <div className="list">
              {failedJobGroups.map((group) => (
                <div key={group.key} className="row">
                  <div className="title">
                    {operationalLabel(language, 'integrationKind', group.kind)}
                  </div>
                  <div className="meta">
                    <span
                      className="badge danger"
                      title={group.errorCode ?? group.status}
                    >
                      {operationalLabel(
                        language,
                        'integrationError',
                        group.errorCode ?? group.status
                      )}
                    </span>{' '}
                    {failedCountLabel(language, group.count)} ·{' '}
                    {t('common.attemptOf', {
                      attempt: group.latestJob.attempt_count,
                      max: group.latestJob.max_attempts,
                      date: formatDateTime(group.latestJob.updated_at, language),
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      ) : null}

      {can(role, 'viewActivity') ? (
        <Section title={t('dashboard.recentActivity')}>
          {data.activity.length === 0 ? (
            <EmptyState compact title={t('dashboard.noActivity')} />
          ) : (
            <ul className="timeline">
              {data.activity.slice(0, 8).map((entry) => (
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
          )}
        </Section>
      ) : null}
    </>
  );
}

function followUpTarget(followUp: FollowUp): string | null {
  if (followUp.enquiry_id) return `/enquiries/${followUp.enquiry_id}`;
  if (followUp.project_id) return `/projects/${followUp.project_id}`;
  if (followUp.client_id) return `/clients/${followUp.client_id}`;
  return null;
}

function failedCountLabel(language: 'en' | 'ru', count: number): string {
  if (language === 'en') return `${count} ${count === 1 ? 'failure' : 'failures'}`;

  const lastTwo = count % 100;
  const last = count % 10;
  const noun = lastTwo >= 11 && lastTwo <= 14
    ? 'ошибок'
    : last === 1
      ? 'ошибка'
      : last >= 2 && last <= 4
        ? 'ошибки'
        : 'ошибок';
  return `${count} ${noun}`;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat dashboard-metric">
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}
