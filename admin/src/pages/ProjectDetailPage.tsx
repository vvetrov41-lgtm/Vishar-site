import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { Link } from '../lib/router';
import { can } from '../lib/permissions';
import { formatDateTime, formatMoney } from '../lib/format';
import type {
  ActivityEntry, CrmSession, InternalNote, Project, ProjectFinance, SessionFinance,
} from '../lib/types';

interface ProjectData {
  project: Project | null;
  finance: ProjectFinance | null;
  sessions: CrmSession[];
  sessionFinance: SessionFinance[];
  notes: InternalNote[];
  activity: ActivityEntry[];
}

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const role = profile?.role;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<ProjectData>(async () => {
    const project = await api.getProject(projectId);
    if (!project) {
      return { project: null, finance: null, sessions: [], sessionFinance: [], notes: [], activity: [] };
    }

    const [finance, sessions, sessionFinance, notes, activity] = await Promise.all([
      can(role, 'viewFinance') ? api.getProjectFinance(projectId) : Promise.resolve(null),
      api.listSessions(projectId),
      can(role, 'viewFinance') ? api.listSessionFinance(projectId) : Promise.resolve([]),
      can(role, 'viewNotes') ? api.listNotes({ projectId }) : Promise.resolve([]),
      can(role, 'viewActivity') ? api.listActivity({}) : Promise.resolve([]),
    ]);

    return { project, finance, sessions, sessionFinance, notes, activity };
  }, [api, projectId, role]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading project…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.project) return <EmptyState title="Project not found" />;

  const { project, finance, sessions, sessionFinance, notes, activity } = data;
  const priceFor = (sessionId: string) =>
    sessionFinance.find((entry) => entry.session_id === sessionId)?.price ?? null;

  return (
    <>
      <div className="card">
        <h2 style={{ fontSize: '1.2rem' }}>{project.title}</h2>
        <div>
          <span className="badge">{project.status}</span>{' '}
          <span className="badge">Deposit: {project.deposit_status.replace(/_/g, ' ')}</span>
        </div>
        {project.description ? (
          <p style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{project.description}</p>
        ) : null}
        <div className="actions">
          <Link to={`/clients/${project.client_id}`} className="badge">Open client</Link>
          {project.enquiry_id ? (
            <Link to={`/enquiries/${project.enquiry_id}`} className="badge">Open enquiry</Link>
          ) : null}
        </div>
      </div>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      <Section title="Estimate">
        <dl className="definition">
          <dt>Sessions</dt><dd>{project.estimated_sessions ?? '—'}</dd>
          <dt>Hours</dt><dd>{project.estimated_hours ?? '—'}</dd>
          {can(role, 'viewFinance') ? (
            <>
              <dt>Hourly rate</dt><dd>{formatMoney(finance?.hourly_rate ?? null, project.currency)}</dd>
              <dt>Estimate total</dt><dd>{formatMoney(finance?.estimate_total ?? null, project.currency)}</dd>
              <dt>Deposit</dt><dd>{formatMoney(finance?.deposit_amount ?? null, project.currency)}</dd>
            </>
          ) : null}
        </dl>
        {!can(role, 'viewFinance') ? (
          <p className="notice" style={{ marginTop: 12 }}>
            Rates and totals are owner-only. They are withheld by the database, not
            hidden by this screen.
          </p>
        ) : null}
      </Section>

      <Section title="Sessions">
        {sessions.length === 0 ? (
          <EmptyState title="No sessions planned" />
        ) : (
          <div className="list">
            {sessions.map((session) => (
              <div key={session.id} className="row">
                <div className="title">{formatDateTime(session.start_at)}</div>
                <div className="meta">
                  <span className={session.status === 'confirmed' ? 'badge ok' : 'badge'}>{session.status}</span>{' '}
                  <span className="badge">{session.payment_status.replace(/_/g, ' ')}</span>{' '}
                  {can(role, 'viewFinance') ? (
                    <span className="badge">{formatMoney(priceFor(session.id), session.currency)}</span>
                  ) : null}
                  <span className="badge">
                    Calendar: {session.calendar_event_id ? 'linked' : 'not connected'}
                  </span>
                </div>
                {can(role, 'manageSessions') && session.status !== 'cancelled' ? (
                  <div className="actions">
                    {session.status !== 'confirmed' ? (
                      <button
                        type="button" disabled={busy}
                        onClick={() => { void run(() => api.setSessionStatus(session.id, 'confirmed')); }}
                      >
                        Confirm
                      </button>
                    ) : null}
                    <button
                      type="button" className="danger" disabled={busy}
                      onClick={() => { void run(() => api.setSessionStatus(session.id, 'cancelled')); }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {can(role, 'manageSessions') ? (
          <div className="actions">
            <button
              type="button" disabled={busy}
              onClick={() => {
                const start = new Date(Date.now() + 14 * 86400000);
                start.setHours(11, 0, 0, 0);
                const end = new Date(start.getTime() + 6 * 3600000);
                void run(() => api.scheduleSession(projectId, start.toISOString(), end.toISOString(), 'proposed'));
              }}
            >
              Propose a session in two weeks
            </button>
          </div>
        ) : null}

        <p className="notice" style={{ marginTop: 12 }}>
          A proposed session never reaches a calendar. Only confirming one queues a
          calendar entry — and no calendar provider is connected yet.
        </p>
      </Section>

      {can(role, 'manageFinance') ? (
        <Section title="Deposit">
          <div className="actions">
            <button
              type="button" disabled={busy}
              onClick={() => { void run(() => api.updateDeposit(projectId, finance?.deposit_amount ?? 0, 'requested')); }}
            >
              Mark requested
            </button>
            <button
              type="button" disabled={busy}
              onClick={() => { void run(() => api.updateDeposit(projectId, finance?.deposit_amount ?? 0, 'paid')); }}
            >
              Mark paid
            </button>
          </div>
        </Section>
      ) : null}

      {can(role, 'viewNotes') ? (
        <Section title="Notes">
          {notes.length === 0 ? <EmptyState title="No notes" /> : (
            <ul className="timeline">
              {notes.map((note) => (
                <li key={note.id}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
                  <div className="when">{formatDateTime(note.created_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {can(role, 'viewActivity') ? (
        <Section title="Activity">
          {activity.length === 0 ? <EmptyState title="No activity recorded" /> : (
            <ul className="timeline">
              {activity.slice(0, 12).map((entry) => (
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
