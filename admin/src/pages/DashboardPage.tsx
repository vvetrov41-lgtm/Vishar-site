import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { Link } from '../lib/router';
import { can } from '../lib/permissions';
import { formatDateTime, relativeDue } from '../lib/format';
import type { ActivityEntry, CrmSession, Enquiry, FollowUp, OutboxJob } from '../lib/types';

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
  const role = profile?.role;

  const { data, loading, error, reload } = useAsync<DashboardData>(async () => {
    // Each of these is fetched independently and any one may come back empty
    // because of row level security rather than because there is nothing there.
    // The role checks below decide what to *ask* for; the database decides what
    // comes back.
    const [enquiries, followUps, sessions, activity, failedJobs] = await Promise.all([
      api.listEnquiries(),
      api.listFollowUps({ open: true }),
      api.listSessions(),
      can(role, 'viewActivity') ? api.listActivity() : Promise.resolve([]),
      can(role, 'viewIntegrationJobs') ? api.listFailedJobs() : Promise.resolve([]),
    ]);
    return { enquiries, followUps, sessions, activity, failedJobs };
  }, [api, role]);

  if (loading) return <LoadingState label="Loading your dashboard…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title="Nothing to show yet" />;

  const now = new Date();
  const newEnquiries = data.enquiries.filter((enquiry) => enquiry.status === 'new');
  const unassigned = data.enquiries.filter((enquiry) => !enquiry.assigned_to);
  const waiting = data.enquiries.filter((enquiry) => enquiry.status === 'waiting_for_client');
  const overdue = data.followUps.filter((followUp) => new Date(followUp.due_at) < now);
  const upcoming = data.sessions
    .filter((session) => session.status === 'confirmed' && new Date(session.start_at) >= now)
    .slice(0, 5);

  return (
    <>
      <Section title="Enquiries">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Metric label="New" value={newEnquiries.length} />
          <Metric label="Unassigned" value={unassigned.length} />
          <Metric label="Waiting" value={waiting.length} />
        </div>
        <div className="actions">
          <Link to="/enquiries" className="badge">Open the enquiry queue</Link>
        </div>
      </Section>

      <Section title="Overdue follow-ups">
        {overdue.length === 0 ? (
          <EmptyState title="Nothing overdue" hint="Follow-ups appear here once their due date passes." />
        ) : (
          <div className="list">
            {overdue.slice(0, 6).map((followUp) => {
              const due = relativeDue(followUp.due_at, now);
              return (
                <div key={followUp.id} className="row">
                  <div className="title">{followUp.subject}</div>
                  <div className="meta">
                    <span className={due.overdue ? 'badge danger' : 'badge'}>{due.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Upcoming confirmed sessions">
        {upcoming.length === 0 ? (
          <EmptyState title="No confirmed sessions ahead" hint="Only confirmed sessions appear here; proposed dates do not." />
        ) : (
          <div className="list">
            {upcoming.map((session) => (
              <div key={session.id} className="row">
                <div className="title">{formatDateTime(session.start_at)}</div>
                <div className="meta">
                  <span className="badge ok">Confirmed</span>{' '}
                  <span className="badge">{session.duration_hours ?? '—'} h</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {can(role, 'viewIntegrationJobs') ? (
        <Section title="Failed integration jobs">
          {data.failedJobs.length === 0 ? (
            <EmptyState
              title="Nothing has failed"
              hint="The durable queue records failures. An automatic retry processor is not connected yet."
            />
          ) : (
            <div className="list">
              {data.failedJobs.map((job) => (
                <div key={job.id} className="row">
                  <div className="title">{job.kind}</div>
                  <div className="meta">
                    <span className="badge danger">{job.last_error_code ?? job.status}</span>{' '}
                    attempt {job.attempt_count} of {job.max_attempts} · {formatDateTime(job.updated_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      ) : null}

      {can(role, 'viewActivity') ? (
        <Section title="Recent activity">
          {data.activity.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="timeline">
              {data.activity.slice(0, 8).map((entry) => (
                <li key={entry.id}>
                  <div>{entry.event_type}</div>
                  <div className="when">{formatDateTime(entry.occurred_at)} · {entry.actor_kind}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}
