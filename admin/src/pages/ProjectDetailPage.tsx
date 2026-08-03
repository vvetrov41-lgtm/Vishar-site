import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { DetailBackLink, RecordArtistContext } from '../components/DetailContext';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { Link } from '../lib/router';
import { can } from '../lib/permissions';
import { formatDateTime, formatMoney } from '../lib/format';
import { useLanguage } from '../lib/i18n';
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
  const { t, label, language } = useLanguage();
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
      setActionError(cause instanceof Error ? cause.message : t('project.actionFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label={t('project.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.project) return <EmptyState title={t('project.notFound')} />;

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
      <DetailBackLink to="/projects" sectionLabel={t('nav.projects')} />
      <RecordArtistContext artistId={project.artist_id} />

      <div className="card">
        <h2 style={{ fontSize: '1.2rem' }}>{project.title}</h2>
        <div>
          <span className="badge">{label('projectStatus', project.status)}</span>{' '}
          <span className="badge">
            {t('common.deposit')}: {label('depositStatus', project.deposit_status)}
          </span>
        </div>
        {project.description ? (
          <p style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{project.description}</p>
        ) : null}
        <div className="actions">
          <Link to={`/clients/${project.client_id}`} className="badge">{t('project.openClient')}</Link>
          {project.enquiry_id ? (
            <Link to={`/enquiries/${project.enquiry_id}`} className="badge">{t('project.openEnquiry')}</Link>
          ) : null}
        </div>
      </div>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      <Section title={t('project.estimate')}>
        <dl className="definition">
          <dt>{t('project.sessions')}</dt><dd>{project.estimated_sessions ?? '—'}</dd>
          <dt>{t('project.hours')}</dt><dd>{project.estimated_hours ?? '—'}</dd>
          {can(role, 'viewFinance') ? (
            <>
              <dt>{t('project.hourlyRate')}</dt>
              <dd>{formatMoney(finance?.hourly_rate ?? null, project.currency, language)}</dd>
              <dt>{t('project.estimateTotal')}</dt>
              <dd>{formatMoney(finance?.estimate_total ?? null, project.currency, language)}</dd>
              <dt>{t('common.deposit')}</dt>
              <dd>{formatMoney(finance?.deposit_amount ?? null, project.currency, language)}</dd>
            </>
          ) : null}
        </dl>
        {!can(role, 'viewFinance') ? (
          <p className="notice" style={{ marginTop: 12 }}>{t('project.ratesOwnerOnly')}</p>
        ) : null}
      </Section>

      <Section title={t('project.sessions')}>
        {sessions.length === 0 ? (
          <EmptyState title={t('project.noSessions')} />
        ) : (
          <div className="list">
            {sessions.map((session) => (
              <div key={session.id} className="row">
                <div className="title">{formatDateTime(session.start_at, language)}</div>
                <div className="meta">
                  <span className={session.status === 'confirmed' ? 'badge ok' : 'badge'}>
                    {label('sessionStatus', session.status)}
                  </span>{' '}
                  <span className="badge">{label('paymentStatus', session.payment_status)}</span>{' '}
                  {can(role, 'viewFinance') ? (
                    <span className="badge">{formatMoney(priceFor(session.id), session.currency, language)}</span>
                  ) : null}{' '}
                  <span className="badge">
                    {t('common.calendar')}: {session.calendar_event_id ? t('common.linked') : t('common.notConnected')}
                  </span>
                </div>
                {can(role, 'manageSessions') ? (
                  <div className="actions">
                    {['draft', 'proposed'].includes(session.status) ? (
                      <button
                        type="button" disabled={busy}
                        onClick={() => { void run(() => api.setSessionStatus(session.id, 'confirmed')); }}
                      >
                        {t('project.confirm')}
                      </button>
                    ) : null}
                    {session.status === 'confirmed' ? (
                      <>
                        <button
                          type="button" disabled={busy}
                          onClick={() => { void run(() => api.setSessionStatus(session.id, 'completed')); }}
                        >
                          {t('project.markCompleted')}
                        </button>
                        <button
                          type="button" disabled={busy}
                          onClick={() => { void run(() => api.setSessionStatus(session.id, 'no_show')); }}
                        >
                          {t('project.markNoShow')}
                        </button>
                      </>
                    ) : null}
                    {['draft', 'proposed', 'confirmed'].includes(session.status) ? (
                      <button
                        type="button" className="danger" disabled={busy}
                        onClick={() => { void run(() => api.setSessionStatus(session.id, 'cancelled')); }}
                      >
                        {t('project.cancel')}
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
                  throw new Error(t('project.invalidSessionTime'));
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
                <label htmlFor="session-start">{t('project.proposedStart')}</label>
                <input
                  id="session-start"
                  type="datetime-local"
                  value={sessionStart}
                  onChange={(event) => setSessionStart(event.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="session-end">{t('project.proposedEnd')}</label>
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
                {t('project.proposeSession')}
              </button>
            </div>
          </form>
        ) : null}

        <p className="notice" style={{ marginTop: 12 }}>{t('project.calendarNotice')}</p>
      </Section>

      {can(role, 'manageFinance') ? (
        <Section title={t('common.deposit')}>
          <label htmlFor="deposit-amount">{t('project.depositAmount', { currency: project.currency })}</label>
          <input
            id="deposit-amount"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={depositAmount}
            placeholder={finance?.deposit_amount?.toString() ?? t('project.enterAmount')}
            onChange={(event) => setDepositAmount(event.target.value)}
          />
          <div className="actions">
            <button
              type="button" disabled={busy || !hasValidDepositAmount}
              onClick={() => {
                void run(() => api.updateDeposit(projectId, parsedDepositAmount, 'requested'));
              }}
            >
              {t('project.markRequested')}
            </button>
            <button
              type="button" disabled={busy || !hasValidDepositAmount}
              onClick={() => {
                void run(() => api.updateDeposit(projectId, parsedDepositAmount, 'paid'));
              }}
            >
              {t('project.markPaid')}
            </button>
          </div>
        </Section>
      ) : null}

      {can(role, 'viewNotes') ? (
        <Section title={t('project.notes')}>
          {notes.length === 0 ? <EmptyState title={t('project.noNotes')} /> : (
            <ul className="timeline">
              {notes.map((note) => (
                <li key={note.id}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
                  <div className="when">{formatDateTime(note.created_at, language)}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {can(role, 'viewActivity') ? (
        <Section title={t('project.activity')}>
          {activity.length === 0 ? <EmptyState title={t('project.noActivity')} /> : (
            <ul className="timeline">
              {activity.slice(0, 12).map((entry) => (
                <li key={entry.id}>
                  <div>{label('event', entry.event_type)}</div>
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
