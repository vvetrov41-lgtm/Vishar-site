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
  const [sessionStart, setSessionStart] = useState('');
  const [sessionEnd, setSessionEnd] = useState('');
  const [depositAmount, setDepositAmount] = useState('');

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
      can(role, 'viewActivity') ? api.listActivity({ projectId }) : Promise.resolve([]),
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
  const parsedDepositAmount = Number(depositAmount);
  const hasValidDepositAmount =
    depositAmount.trim() !== ''
    && Number.isFinite(parsedDepositAmount)
    && parsedDepositAmount > 0;

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
                {can(role, 'manageSessions') ? (
                  <div className="actions">
                    {['draft', 'proposed'].includes(session.status) ? (
                      <button
                        type="button" disabled={busy}
                        onClick={() => { void run(() => api.setSessionStatus(session.id, 'confirmed')); }}
                      >
                        Confirm
                      </button>
                    ) : null}
                    {session.status === 'confirmed' ? (
                      <>
                        <button
                          type="button" disabled={busy}
                          onClick={() => { void run(() => api.setSessionStatus(session.id, 'completed')); }}
                        >
                          Mark completed
                        </button>
                        <button
                          type="button" disabled={busy}
                          onClick={() => { void run(() => api.setSessionStatus(session.id, 'no_show')); }}
                        >
                          Mark no-show
                        </button>
                      </>
                    ) : null}
                    {['draft', 'proposed', 'confirmed'].includes(session.status) ? (
                      <button
                        type="button" className="danger" disabled={busy}
                        onClick={() => { void run(() => api.setSessionStatus(session.id, 'cancelled')); }}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {can(role, 'manageSessions') ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const start = new Date(sessionStart);
                const end = new Date(sessionEnd);
                if (
                  !sessionStart
                  || !sessionEnd
                  || Number.isNaN(start.getTime())
                  || Number.isNaN(end.getTime())
                  || end <= start
                ) {
                  throw new Error('Choose a valid start and a later end time.');
                }
                await api.scheduleSession(
                  projectId,
                  start.toISOString(),
                  end.toISOString(),
                  'proposed'
                );
                setSessionStart('');
                setSessionEnd('');
              });
            }}
          >
            <div className="field-row" style={{ marginTop: 12 }}>
              <div>
                <label htmlFor="session-start">Proposed start</label>
                <input
                  id="session-start"
                  type="datetime-local"
                  value={sessionStart}
                  onChange={(event) => setSessionStart(event.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="session-end">Proposed end</label>
                <input
                  id="session-end"
                  type="datetime-local"
                  value={sessionEnd}
                  onChange={(event) => setSessionEnd(event.target.value)}
                  required
                />
              </div>
            </div>
            <div className="actions">
              <button type="submit" disabled={busy || !sessionStart || !sessionEnd}>
                Propose session
              </button>
            </div>
          </form>
        ) : null}

        <p className="notice" style={{ marginTop: 12 }}>
          A proposed session never reaches a calendar. Only confirming one queues a
          calendar entry — and no calendar provider is connected yet.
        </p>
      </Section>

      {can(role, 'manageFinance') ? (
        <Section title="Deposit">
          <label htmlFor="deposit-amount">Deposit amount ({project.currency})</label>
          <input
            id="deposit-amount"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={depositAmount}
            placeholder={finance?.deposit_amount?.toString() ?? 'Enter amount'}
            onChange={(event) => setDepositAmount(event.target.value)}
          />
          <div className="actions">
            <button
              type="button" disabled={busy || !hasValidDepositAmount}
              onClick={() => {
                void run(() => api.updateDeposit(projectId, parsedDepositAmount, 'requested'));
              }}
            >
              Mark requested
            </button>
            <button
              type="button" disabled={busy || !hasValidDepositAmount}
              onClick={() => {
                void run(() => api.updateDeposit(projectId, parsedDepositAmount, 'paid'));
              }}
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
