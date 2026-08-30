import { useEffect, useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { CollapsibleActivityLog } from '../components/CollapsibleActivityLog';
import { DetailBackLink, RecordArtistContext } from '../components/DetailContext';
import { ProjectAppointmentEditor } from '../components/ProjectAppointmentEditor';
import { ProjectDepositPanel } from '../components/ProjectDepositPanel';
import { ProjectDepositRequirementControl } from '../components/ProjectDepositRequirementControl';
import { ProjectEstimatePanel } from '../components/ProjectEstimatePanel';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { calendarSyncLabel } from '../lib/calendar-sync';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { Link } from '../lib/router';
import { can, canAccess } from '../lib/permissions';
import { formatDateTime, formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { typeLabel } from './AppointmentsPage';
import type { Appointment, AppointmentConflict, AppointmentType } from '../lib/appointment-api';
import type {
  ActivityEntry, InternalNote, Project, ProjectFinance, ProjectStatus, SessionFinance,
} from '../lib/types';

interface ProjectData {
  project: Project | null;
  clientName: string | null;
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

const PROJECT_STATUSES: ProjectStatus[] = ['draft', 'active', 'on_hold', 'completed', 'cancelled'];

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;
  const copy = COPY[language];
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [appointmentType, setAppointmentType] = useState<AppointmentType>('tattoo_session');
  const [appointmentStart, setAppointmentStart] = useState('');
  const [appointmentEnd, setAppointmentEnd] = useState('');
  const [conflicts, setConflicts] = useState<AppointmentConflict[]>([]);
  const [conflictAcknowledged, setConflictAcknowledged] = useState(false);
  const [bookedNotice, setBookedNotice] = useState<string | null>(null);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>('draft');

  const { data, loading, error, reload } = useAsync<ProjectData>(async () => {
    const project = await api.getProject(projectId);
    if (!project) {
      return {
        project: null,
        clientName: null,
        finance: null,
        appointments: [],
        sessionFinance: [],
        notes: [],
        activity: [],
      };
    }

    const scopedMemberships = memberships.filter((membership) => membership.artist_id === project.artist_id);
    const mayViewFinance = canAccess(role, 'viewFinance', scopedMemberships);
    const [finance, appointments, sessionFinance, notes, activity] = await Promise.all([
      mayViewFinance ? api.getProjectFinance(projectId) : Promise.resolve(null),
      api.listAppointments({ projectId }),
      mayViewFinance ? api.listSessionFinance(projectId) : Promise.resolve([]),
      can(role, 'viewNotes') ? api.listNotes({ projectId }) : Promise.resolve([]),
      can(role, 'viewActivity') ? api.listActivity({ projectId }) : Promise.resolve([]),
    ]);

    // Booking a session without seeing whose session it is was the sharpest
    // instance of the project page describing the record instead of the person.
    const [clientRow] = await api.listClientsByIds([project.client_id]);

    return {
      project,
      clientName: clientRow?.full_name ?? null,
      finance,
      appointments,
      sessionFinance,
      notes,
      activity,
    };
  }, [api, projectId, role, memberships]);

  useEffect(() => {
    if (data?.project) setProjectStatus(data.project.status);
  }, [data?.project?.status]);

  useEffect(() => {
    let cancelled = false;
    const startIso = inputToIso(appointmentStart);
    const endIso = inputToIso(appointmentEnd);
    const artistId = data?.project?.artist_id;

    if (!artistId || !startIso || !endIso || endIso <= startIso) {
      setConflicts([]);
      setConflictAcknowledged(false);
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

  const { project, clientName, finance, appointments, sessionFinance, notes, activity } = data;
  const scopedMemberships = memberships.filter((membership) => membership.artist_id === project.artist_id);
  const mayViewFinance = canAccess(role, 'viewFinance', scopedMemberships);
  const mayManageFinance = canAccess(role, 'manageFinance', scopedMemberships);
  const mayManageAppointments = role === 'owner' || (
    role === 'booking_manager'
    && scopedMemberships.some((membership) => membership.is_active && membership.can_manage_sessions)
  );
  const mayManageProject = role === 'owner' || (
    role === 'booking_manager'
    && scopedMemberships.some((membership) => membership.is_active && membership.access_level !== 'read_only')
  );
  const mayEditEstimate = role === 'owner';
  const priceFor = (appointmentId: string) =>
    sessionFinance.find((entry) => entry.session_id === appointmentId)?.price ?? null;
  const hasConfirmedWork = appointments.some((appointment) => ['confirmed', 'completed'].includes(appointment.status));
  const lifecycleMismatch = project.status === 'draft' && (project.deposit_status === 'paid' || hasConfirmedWork);
  const conflictMessage = conflicts.length > 0
    ? copy.conflicts(conflicts.length, formatDateTime(conflicts[0].start_at, language))
    : null;

  return (
    <>
      <DetailBackLink to="/projects" sectionLabel={t('nav.projects')} />
      <RecordArtistContext artistId={project.artist_id} />

      <div className="card">
        <h2 style={{ fontSize: '1.2rem' }}>{clientName ?? project.title}</h2>
        {clientName ? (
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', margin: '0 0 8px' }}>
            {project.title}
          </p>
        ) : null}
        <div>
          <span className="badge">{projectStatusLabel(project.status, language)}</span>{' '}
          <span className={project.deposit_status === 'paid' ? 'badge ok' : 'badge'}>
            {copy.deposit}: {depositStatusLabel(project.deposit_status, language, finance?.deposit_amount ?? null)}
            {mayViewFinance && finance?.deposit_amount !== null && finance?.deposit_amount !== undefined
              ? ` · ${formatMoney(finance.deposit_amount, project.currency, language)}`
              : ''}
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

        {mayManageProject ? (
          <div style={{ marginTop: 14 }}>
            <label htmlFor="project-status">{copy.projectStatus}</label>
            <div className="field-row">
              <select
                id="project-status"
                value={projectStatus}
                disabled={busy}
                onChange={(event) => setProjectStatus(event.target.value as ProjectStatus)}
              >
                {PROJECT_STATUSES.map((status) => (
                  <option key={status} value={status}>{projectStatusLabel(status, language)}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || projectStatus === project.status}
                onClick={() => {
                  void (async () => {
                    if (projectStatus === 'cancelled') {
                      const approved = await confirmDialog({
                        title: copy.cancelProjectTitle,
                        message: copy.cancelProjectConfirm,
                        confirmLabel: copy.cancelProjectAction,
                        cancelLabel: cancelLabelFor(language),
                      });
                      if (!approved) return;
                    }
                    await run(() => api.setProjectStatus(project.id, projectStatus));
                  })();
                }}
              >
                {copy.saveStatus}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {lifecycleMismatch ? (
        <div className="notice warn" role="status">{copy.draftMismatch}</div>
      ) : null}
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      <Section title={t('project.estimate')}>
        <ProjectEstimatePanel
          project={project}
          finance={finance}
          appointments={appointments}
          mayViewFinance={mayViewFinance}
          mayManage={mayEditEstimate}
          onSaved={reload}
        />
        {!mayViewFinance ? (
          <p className="notice" style={{ marginTop: 12 }}>{t('project.ratesOwnerOnly')}</p>
        ) : null}
      </Section>

      <Section title={copy.appointments}>
        {appointments.length === 0 ? (
          <EmptyState title={copy.noAppointments} />
        ) : (
          <div className="list">
            {appointments.map((appointment) => {
              const price = priceFor(appointment.id);
              const active = ['draft', 'proposed', 'confirmed'].includes(appointment.status);
              return (
                <div key={appointment.id} className="row">
                  <div className="title">{formatDateTime(appointment.start_at, language)}</div>
                  <div className="meta">
                    <span className="badge">{typeLabel(appointment.appointment_type, language)}</span>{' '}
                    <span className={appointment.status === 'confirmed' ? 'badge ok' : 'badge'}>
                      {label('sessionStatus', appointment.status)}
                    </span>{' '}
                    <span className="badge">{durationValue(appointment.duration_hours, language)}</span>{' '}
                    <span className={appointment.payment_status === 'paid' ? 'badge ok' : 'badge'}>
                      {copy.appointmentPayment}: {label('paymentStatus', appointment.payment_status)}
                    </span>{' '}
                    {mayViewFinance && price !== null ? (
                      <span className="badge">{copy.appointmentPrice}: {formatMoney(price, appointment.currency, language)}</span>
                    ) : null}{' '}
                    <span className={appointment.calendar_sync_status === 'failed' ? 'badge warn' : appointment.calendar_sync_status === 'synced' ? 'badge ok' : 'badge'}>
                      {copy.calendar}: {calendarSyncLabel(appointment, language)}
                    </span>
                  </div>

                  {mayManageAppointments && active ? (
                    <ProjectAppointmentEditor appointment={appointment} disabled={busy} onSaved={reload} />
                  ) : null}

                  {mayManageAppointments ? (
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
                      {active ? (
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

        {mayManageAppointments ? (
          <details style={{ marginTop: 14 }}>
            <summary>{copy.addAppointment}</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setBookedNotice(null);
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
                  // Say what was booked, for whom and when. The form used to
                  // clear itself and leave a new row somewhere in the list as
                  // the only evidence anything had happened.
                  setBookedNotice(copy.booked(
                    typeLabel(appointmentType, language),
                    clientName ?? project.title,
                    formatDateTime(start, language),
                  ));
                  setAppointmentStart('');
                  setAppointmentEnd('');
                  setConflicts([]);
                  setConflictAcknowledged(false);
                });
              }}
            >
              <label htmlFor="appointment-type" style={{ marginTop: 12 }}>{copy.appointmentType}</label>
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
                  <label htmlFor="appointment-start">{copy.proposedStart}</label>
                  <input
                    id="appointment-start"
                    type="datetime-local"
                    value={appointmentStart}
                    onChange={(event) => setAppointmentStart(event.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="appointment-end">{copy.proposedEnd}</label>
                  <input
                    id="appointment-end"
                    type="datetime-local"
                    value={appointmentEnd}
                    onChange={(event) => setAppointmentEnd(event.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="actions" role="group" aria-label={copy.duration}>
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
              {checkingConflicts ? <div className="notice">{copy.checking}</div> : null}
              {/* Same conflict policy as every other booking form: state the
                  clash assertively, and require the operator to say they meant
                  it rather than letting them scroll past a polite notice. */}
              {conflictMessage ? (
                <div className="notice warn" role="alert">
                  <p style={{ margin: 0 }}>{conflictMessage}</p>
                  <label className="conflict-acknowledgement">
                    <input
                      type="checkbox"
                      checked={conflictAcknowledged}
                      onChange={(event) => setConflictAcknowledged(event.target.checked)}
                    />
                    <span>{copy.bookAnyway}</span>
                  </label>
                </div>
              ) : null}
              {bookedNotice ? <div className="notice ok" role="status">{bookedNotice}</div> : null}
              <div className="actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    busy
                    || !appointmentStart
                    || !appointmentEnd
                    || (conflicts.length > 0 && !conflictAcknowledged)
                  }
                >
                  {copy.propose}
                </button>
              </div>
            </form>
          </details>
        ) : null}

        <p className="notice" style={{ marginTop: 12 }}>{copy.calendarNotice}</p>
      </Section>

      {mayManageFinance ? (
        <Section title={copy.deposit}>
          <ProjectDepositRequirementControl project={project} onChanged={reload} />
          <ProjectDepositPanel
            project={project}
            finance={finance}
            appointments={appointments}
            onChanged={reload}
          />
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
          <CollapsibleActivityLog activity={activity} emptyTitle={t('project.noActivity')} />
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

function projectStatusLabel(status: ProjectStatus, language: Language): string {
  const labels = {
    en: { draft: 'draft', active: 'active', on_hold: 'on hold', completed: 'completed', cancelled: 'cancelled' },
    ru: { draft: 'черновик', active: 'активный', on_hold: 'на паузе', completed: 'завершён', cancelled: 'отменён' },
  } as const;
  return labels[language][status];
}

function depositStatusLabel(
  status: Project['deposit_status'],
  language: Language,
  depositAmount: number | null,
): string {
  if (status === 'not_required') {
    return depositAmount === 0
      ? (language === 'ru' ? 'не требуется' : 'not required')
      : (language === 'ru' ? 'ещё не запрошен' : 'not requested yet');
  }

  const labels = {
    en: { requested: 'requested', paid: 'paid', refunded: 'refunded', forfeited: 'forfeited' },
    ru: { requested: 'запрошен', paid: 'оплачен', refunded: 'возвращён', forfeited: 'удержан' },
  } as const;
  return labels[language][status];
}

const COPY = {
  en: {
    deposit: 'Deposit',
    projectStatus: 'Project status',
    saveStatus: 'Save status',
    cancelProjectConfirm: 'Mark this project cancelled?',
    cancelProjectTitle: 'Cancel this project?',
    cancelProjectAction: 'Cancel project',
    draftMismatch: 'This project is still a draft even though it already has a paid deposit or confirmed work. Set it to Active if work is proceeding.',
    appointments: 'Appointments',
    noAppointments: 'No appointments planned',
    appointmentPayment: 'Session payment',
    appointmentPrice: 'Planned price',
    calendar: 'Calendar',
    addAppointment: 'Add another appointment',
    appointmentType: 'Appointment type',
    proposedStart: 'Proposed start',
    proposedEnd: 'Proposed end',
    duration: 'Duration shortcuts',
    checking: 'Checking the schedule…',
    conflicts: (count: number, date: string) => `Conflicting active appointments: ${count}. The first starts ${date}.`,
    bookAnyway: 'I mean to book over this clash',
    booked: (type: string, client: string, date: string) => `${type} booked for ${client}, ${date}. It is proposed until you confirm it.`,
    propose: 'Propose appointment',
    calendarNotice: 'CRM is the schedule source of truth. Proposed appointments stay in CRM; each confirmed appointment shows its actual Google Calendar sync state above.',
  },
  ru: {
    deposit: 'Депозит',
    projectStatus: 'Статус проекта',
    saveStatus: 'Сохранить статус',
    cancelProjectConfirm: 'Отметить этот проект отменённым?',
    cancelProjectTitle: 'Отменить проект?',
    cancelProjectAction: 'Отменить проект',
    draftMismatch: 'Проект всё ещё в черновике, хотя депозит уже оплачен или есть подтверждённая запись. Если работа идёт, переведи проект в статус «активный».',
    appointments: 'Записи',
    noAppointments: 'Записей пока нет',
    appointmentPayment: 'Оплата сеанса',
    appointmentPrice: 'Плановая стоимость',
    calendar: 'Календарь',
    addAppointment: 'Добавить ещё одну запись',
    appointmentType: 'Тип записи',
    proposedStart: 'Предлагаемое начало',
    proposedEnd: 'Предлагаемое окончание',
    duration: 'Быстрый выбор длительности',
    checking: 'Проверяем расписание…',
    conflicts: (count: number, date: string) => `Пересекающихся активных записей: ${count}. Первая начинается ${date}.`,
    bookAnyway: 'Я осознанно записываю поверх пересечения',
    booked: (type: string, client: string, date: string) => `${type} для ${client} записан на ${date}. Запись предложена и ждёт подтверждения.`,
    propose: 'Предложить запись',
    calendarNotice: 'Расписание в CRM является основным. Предложенные записи остаются в CRM, а у каждой подтверждённой записи выше показывается фактический статус синхронизации с Google Calendar.',
  },
} as const;
