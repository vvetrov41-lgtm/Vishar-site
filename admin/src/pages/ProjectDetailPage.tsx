import { useEffect, useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { CollapsibleActivityLog } from '../components/CollapsibleActivityLog';
import { DetailBackLink, RecordArtistContext } from '../components/DetailContext';
import { BookingPanel } from '../components/BookingPanel';
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
import type { Appointment } from '../lib/appointment-api';
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



const PROJECT_STATUSES: ProjectStatus[] = ['draft', 'active', 'on_hold', 'completed', 'cancelled'];

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;
  const copy = COPY[language];
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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

      {/* The same panel as the client workspace and the calendar. A project
          books through the project, so the session is linked without the
          operator having to remember to pick it. */}
      {mayManageAppointments ? (
        <Section title={t('booking.title')}>
          <BookingPanel
            artistId={project.artist_id}
            clientId={project.client_id}
            clientName={clientName ?? project.title}
            projectId={project.id}
            onBooked={() => reload()}
          />
        </Section>
      ) : null}

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

        {/* The inline planner that used to live here is gone. The shared
            booking panel above does everything it did - durations, manual
            entry and the pre-submit clash warning - and is the same panel
            every other screen uses. */}

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
