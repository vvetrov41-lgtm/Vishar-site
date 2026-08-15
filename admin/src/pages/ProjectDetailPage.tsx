import { useEffect, useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { DetailBackLink, RecordArtistContext } from '../components/DetailContext';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { Link } from '../lib/router';
import { can } from '../lib/permissions';
import { formatDateTime, formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { operationalLabel } from '../lib/operational-labels';
import { typeLabel } from './AppointmentsPage';
import type { Appointment, AppointmentConflict, AppointmentType } from '../lib/appointment-api';
import type {
  ActivityEntry, InternalNote, Project, ProjectFinance, SessionFinance,
} from '../lib/types';

interface ProjectData {
  project: Project | null;
  finance: ProjectFinance | null;
  appointments: Appointment[];
  sessionFinance: SessionFinance[];
  notes: InternalNote[];
  activity: ActivityEntry[];
}

const PROJECT_DURATION_MINUTES: Record<AppointmentType, number[]> = {
  tattoo_session: [180, 300, 420],
  in_person_consultation: [15, 20, 30],
  video_consultation: [15, 20, 30],
  touch_up: [60, 120, 180],
};

const APPOINTMENT_TYPES: AppointmentType[] = [
  'tattoo_session',
  'in_person_consultation',
  'video_consultation',
  'touch_up',
];

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [appointmentType, setAppointmentType] = useState<AppointmentType>('tattoo_session');
  const [appointmentStart, setAppointmentStart] = useState('');
  const [appointmentEnd, setAppointmentEnd] = useState('');
  const [conflicts, setConflicts] = useState<AppointmentConflict[]>([]);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');

  const { data, loading, error, reload } = useAsync<ProjectData>(async () => {
    const project = await api.getProject(projectId);
    if (!project) {
      return {
        project: null,
        finance: null,
        appointments: [],
        sessionFinance: [],
        notes: [],
        activity: [],
      };
    }

    const [finance, appointments, sessionFinance, notes, activity] = await Promise.all([
      can(role, 'viewFinance') ? api.getProjectFinance(projectId) : Promise.resolve(null),
      api.listAppointments({ projectId }),
      can(role, 'viewFinance') ? api.listSessionFinance(projectId) : Promise.resolve([]),
      can(role, 'viewNotes') ? api.listNotes({ projectId }) : Promise.resolve([]),
      can(role, 'viewActivity') ? api.listActivity({ projectId }) : Promise.resolve([]),
    ]);

    return { project, finance, appointments, sessionFinance, notes, activity };
  }, [api, projectId, role]);

  useEffect(() => {
    let cancelled = false;
    const startIso = inputToIso(appointmentStart);
    const endIso = inputToIso(appointmentEnd);
    const artistId = data?.project?.artist_id;

    if (!artistId || !startIso || !endIso || endIso <= startIso) {
      setConflicts([]);
      setCheckingConflicts(false);
      return undefined;
    }

    setCheckingConflicts(true);
    api.listAppointmentConflicts({ artistId, startAt: startIso, endAt: endIso })
      .then((rows) => { if (!cancelled) setConflicts(rows); })
      .catch(() => { if (!cancelled) setConflicts([]); })
      .finally(() => { if (!cancelled) setCheckingConflicts(false); });

    return () => { cancelled = true; };
  }, [api, data?.project?.artist_id, appointmentStart, appointmentEnd]);

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

  const { project, finance, appointments, sessionFinance, notes, activity } = data;
  const priceFor = (appointmentId: string) =>
    sessionFinance.find((entry) => entry.session_id === appointmentId)?.price ?? null;
  const parsedDepositAmount = Number(depositAmount);
  const hasValidDepositAmount =
    depositAmount.trim() !== ''
    && Number.isFinite(parsedDepositAmount)
    && parsedDepositAmount > 0;
  const appointmentTitle = language === 'ru' ? 'Записи' : 'Appointments';
  const noAppointments = language === 'ru' ? 'Записей пока нет' : 'No appointments planned';
  const proposeLabel = language === 'ru' ? 'Предложить запись' : 'Propose appointment';
  const startLabel = language === 'ru' ? 'Предлагаемое начало' : 'Proposed start';
  const endLabel = language === 'ru' ? 'Предлагаемое окончание' : 'Proposed end';
  const typeSelectLabel = language === 'ru' ? 'Тип записи' : 'Appointment type';
  const durationLabel = language === 'ru' ? 'Выбрать длительность' : 'Set duration';
  const conflictMessage = conflicts.length > 0
    ? language === 'ru'
      ? `Пересекающихся активных записей: ${conflicts.length}. Первая начинается ${formatDateTime(conflicts[0].start_at, language)}. Это время всё равно можно предложить, если пересечение намеренное.`
      : `Conflicting active appointments: ${conflicts.length}. The first starts ${formatDateTime(conflicts[0].start_at, language)}. You can still propose this time if the overlap is intentional.`
    : null;

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

      <Section title={appointmentTitle}>
        {appointments.length === 0 ? (
          <EmptyState title={noAppointments} />
        ) : (
          <div className="list">
            {appointments.map((appointment) => {
              const price = priceFor(appointment.id);
              return (
                <div key={appointment.id} className="row">
                  <div className="title">{formatDateTime(appointment.start_at, language)}</div>
                  <div className="meta">
                    <span className="badge">{typeLabel(appointment.appointment_type, language)}</span>{' '}
                    <span className={appointment.status === 'confirmed' ? 'badge ok' : 'badge'}>
                      {label('sessionStatus', appointment.status)}
                    </span>{' '}
                    <span className="badge">{durationValue(appointment.duration_hours, language)}</span>{' '}
                    <span className="badge">{label('paymentStatus', appointment.payment_status)}</span>{' '}
                    {can(role, 'viewFinance') && price !== null ? (
                      <span className="badge">{formatMoney(price, appointment.currency, language)}</span>
                    ) : null}{' '}
                    <span className="badge">
                      {t('common.calendar')}: {appointment.calendar_event_id ? t('common.linked') : t('common.notConnected')}
                    </span>
                  </div>
                  {can(role, 'manageSessions') ? (
                    <div className="actions">
                      {['draft', 'proposed'].includes(appointment.status) ? (
                        <button
                          type="button" disabled={busy}
                          onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'confirmed')); }}
                        >
                          {t('project.confirm')}
                        </button>
                      ) : null}
                      {appointment.status === 'confirmed' ? (
                        <>
                          <button
                            type="button" disabled={busy}
                            onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'completed')); }}
                          >
                            {t('project.markCompleted')}
                          </button>
                          <button
                            type="button" disabled={busy}
                            onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'no_show')); }}
                          >
                            {t('project.markNoShow')}
                          </button>
                        </>
                      ) : null}
                      {['draft', 'proposed', 'confirmed'].includes(appointment.status) ? (
                        <button
                          type="button" className="danger" disabled={busy}
                          onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'cancelled')); }}
                        >
                          {t('project.cancel')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {can(role, 'manageSessions') ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const start = inputToIso(appointmentStart);
                const end = inputToIso(appointmentEnd);
                if (!start || !end || end <= start) {
                  throw new Error(t('project.invalidSessionTime'));
                }
                await api.scheduleAppointment({
                  artistId: project.artist_id,
                  clientId: project.client_id,
                  appointmentType,
                  startAt: start,
                  endAt: end,
                  status: 'proposed',
                  enquiryId: project.enquiry_id,
                  projectId,
                });
                setAppointmentStart('');
                setAppointmentEnd('');
                setConflicts([]);
              });
            }}
          >
            <label htmlFor="appointment-type" style={{ marginTop: 12 }}>{typeSelectLabel}</label>
            <select
              id="appointment-type"
              value={appointmentType}
              onChange={(event) => setAppointmentType(event.target.value as AppointmentType)}
            >
              {APPOINTMENT_TYPES.map((type) => (
                <option key={type} value={type}>{typeLabel(type, language)}</option>
              ))}
            </select>

            <div className="field-row" style={{ marginTop: 12 }}>
              <div>
                <label htmlFor="appointment-start">{startLabel}</label>
                <input
                  id="appointment-start"
                  type="datetime-local"
                  value={appointmentStart}
                  onChange={(event) => setAppointmentStart(event.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="appointment-end">{endLabel}</label>
                <input
                  id="appointment-end"
                  type="datetime-local"
                  value={appointmentEnd}
                  onChange={(event) => setAppointmentEnd(event.target.value)}
                  required
                />
              </div>
            </div>
            <div className="actions" role="group" aria-label={durationLabel}>
              {PROJECT_DURATION_MINUTES[appointmentType].map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={busy || !appointmentStart}
                  onClick={() => {
                    const end = addMinutesToLocalDateTime(appointmentStart, minutes);
                    if (end) setAppointmentEnd(end);
                  }}
                >
                  {durationShortcut(minutes, language)}
                </button>
              ))}
            </div>
            {checkingConflicts ? (
              <div className="notice">{language === 'ru' ? 'Проверяем расписание…' : 'Checking the schedule…'}</div>
            ) : null}
            {conflictMessage ? (
              <div className="notice warn" role="alert">{conflictMessage}</div>
            ) : null}
            <div className="actions">
              <button type="submit" disabled={busy || !appointmentStart || !appointmentEnd}>
                {proposeLabel}
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

function inputToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function addMinutesToLocalDateTime(value: string, minutes: number): string | null {
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + minutes * 60_000);
  const local = new Date(end.getTime() - end.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function durationShortcut(minutes: number, language: Language): string {
  if (minutes < 60) return language === 'ru' ? `${minutes} мин` : `${minutes} min`;
  const hours = minutes / 60;
  return language === 'ru' ? `${hours} ч` : `${hours} h`;
}

function durationValue(hours: number | null, language: Language): string {
  if (hours === null) return '—';
  if (hours < 1) return durationShortcut(Math.round(hours * 60), language);
  return language === 'ru' ? `${hours} ч` : `${hours} h`;
}
