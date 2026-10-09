import { isBlockingDetailLoad } from '../lib/detail-loading';
import { useEffect, useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { ActivityFeed } from '../components/ActivityFeed';
import { DetailHeader } from '../components/DetailContext';
import { BookingDisclosure } from '../components/BookingDisclosure';
import { BookingPanel } from '../components/BookingPanel';
import { ProjectAppointmentEditor } from '../components/ProjectAppointmentEditor';
import { BookingCardStatusLine } from '../components/BookingCardStatusLine';
import { SessionPricesPanel } from '../components/SessionPricesPanel';
import { ProjectDepositPanel } from '../components/ProjectDepositPanel';
import { ProjectInvoicesPanel } from '../components/ProjectInvoicesPanel';
import { ProjectDepositRequirementControl } from '../components/ProjectDepositRequirementControl';
import { ProjectEstimatePanel } from '../components/ProjectEstimatePanel';
import { ProjectSourceEnquiry } from '../components/ProjectSourceEnquiry';
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
  InternalNote, Project, ProjectFinance, ProjectStatus, SessionFinance,
} from '../lib/types';

interface ProjectData {
  project: Project | null;
  clientName: string | null;
  finance: ProjectFinance | null;
  appointments: Appointment[];
  sessionFinance: SessionFinance[];
  notes: InternalNote[];
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
      };
    }

    const scopedMemberships = memberships.filter((membership) => membership.artist_id === project.artist_id);
    const mayViewFinance = canAccess(role, 'viewFinance', scopedMemberships);
    const [finance, appointments, sessionFinance, notes] = await Promise.all([
      mayViewFinance ? api.getProjectFinance(projectId) : Promise.resolve(null),
      api.listAppointments({ projectId }),
      mayViewFinance ? api.listSessionFinance(projectId) : Promise.resolve([]),
      can(role, 'viewNotes') ? api.listNotes({ projectId }) : Promise.resolve([]),
    ]);

    const [clientRow] = await api.listClientsByIds([project.client_id]);

    return {
      project,
      clientName: clientRow?.full_name ?? null,
      finance,
      appointments,
      sessionFinance,
      notes,
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

  if (isBlockingDetailLoad(loading, data?.project?.id, projectId)) return <LoadingState label={t('project.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.project) return <EmptyState title={t('project.notFound')} />;

  const { project, clientName, finance, appointments, sessionFinance, notes } = data;
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
  const now = Date.now();
  const nextAppointment = [...appointments]
    .filter((appointment) => ['draft', 'proposed', 'confirmed'].includes(appointment.status))
    .filter((appointment) => {
      const endAt = new Date(appointment.end_at).getTime();
      if (Number.isFinite(endAt)) return endAt > now;
      const startAt = new Date(appointment.start_at).getTime();
      return Number.isFinite(startAt) && startAt >= now;
    })
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())[0] ?? null;

  async function changeProjectStatus(nextStatus: ProjectStatus) {
    if (nextStatus === project.status) return;
    if (nextStatus === 'cancelled') {
      const approved = await confirmDialog({
        title: copy.cancelProjectTitle,
        message: copy.cancelProjectConfirm,
        confirmLabel: copy.cancelProjectAction,
        cancelLabel: cancelLabelFor(language),
      });
      if (!approved) {
        setProjectStatus(project.status);
        return;
      }
    }

    setProjectStatus(nextStatus);
    setBusy(true);
    setActionError(null);
    try {
      await api.setProjectStatus(project.id, nextStatus);
      reload();
    } catch (cause) {
      setProjectStatus(project.status);
      setActionError(cause instanceof Error ? cause.message : t('project.actionFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DetailHeader to="/projects" sectionLabel={t('nav.projects')} artistId={project.artist_id} />

      <div className="card">
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.2rem', marginBottom: clientName ? 3 : 8 }}>{clientName ?? project.title}</h2>
            {clientName ? (
              <p style={{ color: 'var(--muted)', fontSize: '0.9rem', margin: '0 0 8px' }}>{project.title}</p>
            ) : null}
          </div>
          <span className={project.status === 'active' ? 'badge ok' : 'badge'}>{projectStatusLabel(project.status, language)}</span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <span className={project.deposit_status === 'paid' ? 'badge ok' : 'badge'}>
            {copy.deposit}: {depositStatusLabel(project.deposit_status, language, finance?.deposit_amount ?? null)}
            {mayViewFinance && finance?.deposit_amount !== null && finance?.deposit_amount !== undefined
              ? ` · ${formatMoney(finance.deposit_amount, project.currency, language)}`
              : ''}
          </span>
          {nextAppointment ? (
            <span className="badge ok">
              {copy.next}: {formatDateTime(nextAppointment.start_at, language)} · {durationValue(nextAppointment.duration_hours, language)}
            </span>
          ) : null}
        </div>

        {project.description ? (
          <p style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)', marginBlock: 10 }}>{project.description}</p>
        ) : null}
        <div className="actions" style={{ marginTop: 10 }}>
          <Link to={`/clients/${project.client_id}`} className="badge">{t('project.openClient')}</Link>
          {project.enquiry_id ? <Link to={`/enquiries/${project.enquiry_id}`} className="badge">{t('project.openEnquiry')}</Link> : null}
        </div>

        {mayManageProject ? (
          <div style={{ marginTop: 12 }}>
            <label htmlFor="project-status">{copy.projectStatus}</label>
            <select
              id="project-status"
              value={projectStatus}
              disabled={busy}
              onChange={(event) => { void changeProjectStatus(event.target.value as ProjectStatus); }}
            >
              {PROJECT_STATUSES.map((status) => (
                <option key={status} value={status}>{projectStatusLabel(status, language)}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {lifecycleMismatch ? <div className="notice warn" role="status">{copy.draftMismatch}</div> : null}
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      <ProjectSectionNav
        ru={language === 'ru'}
        showNotes={can(role, 'viewNotes')}
        showActivity={can(role, 'viewActivity')}
      />

      {project.enquiry_id ? <ProjectSourceEnquiry enquiryId={project.enquiry_id} role={role} /> : null}

      <Section title={copy.appointments} id="project-sessions">
        {mayManageFinance ? (
          <SessionPricesPanel
            artistId={project.artist_id}
            appointments={appointments}
            priceFor={priceFor}
            projectHourlyRate={finance?.hourly_rate ?? null}
            currency={finance?.currency ?? project.currency}
            onSaved={reload}
          />
        ) : null}
        {appointments.length === 0 ? (
          <EmptyState title={copy.noAppointments} />
        ) : (
          <div className="list">
            {appointments.map((appointment) => {
              const price = priceFor(appointment.id);
              const active = ['draft', 'proposed', 'confirmed'].includes(appointment.status);
              return (
                <div key={appointment.id} className="row" style={{ paddingBlock: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <div className="title">{formatDateTime(appointment.start_at, language)}</div>
                    <span className={appointment.status === 'confirmed' ? 'badge ok' : 'badge'}>
                      {label('sessionStatus', appointment.status)}
                    </span>
                  </div>
                  <div className="meta" style={{ marginTop: 4 }}>
                    {typeLabel(appointment.appointment_type, language)} · {durationValue(appointment.duration_hours, language)}
                    {' · '}{label('paymentStatus', appointment.payment_status)}
                    {mayViewFinance && price !== null ? ` · ${formatMoney(price, appointment.currency, language)}` : ''}
                    {` · ${copy.calendar}: ${calendarSyncLabel(appointment, language)}`}
                  </div>
                  {active ? (
                    <BookingCardStatusLine
                      sessionId={appointment.id}
                      refreshKey={`${appointment.status}:${appointment.start_at}:${appointment.calendar_version}:${price ?? ''}:${project.deposit_status}`}
                    />
                  ) : null}

                  {mayManageAppointments && active ? (
                    <ProjectAppointmentEditor
                      appointment={appointment}
                      sessionPrice={price}
                      projectHourlyRate={finance?.hourly_rate ?? null}
                      canManagePrice={mayManageFinance}
                      disabled={busy}
                      onSaved={reload}
                    />
                  ) : null}

                  {mayManageAppointments ? (
                    <div className="actions" style={{ marginTop: 10 }}>
                      {['draft', 'proposed'].includes(appointment.status) ? (
                        <button type="button" disabled={busy} onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'confirmed')); }}>
                          {t('project.confirm')}
                        </button>
                      ) : null}
                      {appointment.status === 'confirmed' ? (
                        <>
                          <button type="button" disabled={busy} onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'completed')); }}>
                            {t('project.markCompleted')}
                          </button>
                          <button type="button" disabled={busy} onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'no_show')); }}>
                            {t('project.markNoShow')}
                          </button>
                        </>
                      ) : null}
                      {active ? (
                        <button type="button" className="danger" disabled={busy} onClick={() => { void run(() => api.setAppointmentStatus(appointment.id, 'cancelled')); }}>
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

        <details style={{ marginTop: 10 }}>
          <summary className="meta" style={{ cursor: 'pointer' }}>{copy.calendarHelp}</summary>
          <p className="notice" style={{ marginTop: 8 }}>{copy.calendarNotice}</p>
        </details>
      </Section>

      {/* What is already booked comes first. The form opens by itself only
          when there is nothing booked yet, because then it is the next step. */}
      {mayManageAppointments ? (
        <BookingDisclosure id="project-book" defaultOpen={appointments.length === 0}>
          <BookingPanel
            artistId={project.artist_id}
            clientId={project.client_id}
            clientName={clientName ?? project.title}
            projectId={project.id}
            onBooked={() => reload()}
          />
        </BookingDisclosure>
      ) : null}

      <Section title={t('project.estimate')} id="project-money">
        <ProjectEstimatePanel
          project={project}
          finance={finance}
          appointments={appointments}
          mayViewFinance={mayViewFinance}
          mayManage={mayEditEstimate}
          onSaved={reload}
        />
        {!mayViewFinance ? <p className="notice" style={{ marginTop: 12 }}>{t('project.ratesOwnerOnly')}</p> : null}
      </Section>

      {mayManageFinance ? (
        <Section title={copy.deposit}>
          <ProjectDepositRequirementControl project={project} onChanged={reload} />
          <ProjectDepositPanel project={project} finance={finance} appointments={appointments} onChanged={reload} />
        </Section>
      ) : null}

      {mayViewFinance ? (
        <Section title={copy.invoices}>
          <ProjectInvoicesPanel
            projectId={project.id}
            currency={project.currency}
            mayManage={mayManageFinance}
          />
        </Section>
      ) : null}

      {can(role, 'viewNotes') ? (
        <Section title={t('project.notes')} id="project-notes">
          {notes.length === 0 ? <p className="meta" style={{ margin: 0 }}>{t('project.noNotes')}</p> : (
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
        <Section title={t('project.activity')} id="project-activity">
          <ActivityFeed
            filter={{ projectId: project.id }}
            emptyTitle={t('project.noActivity')}
            initiallyCollapsed
          />
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
    invoices: 'Invoices',
    next: 'Next',
    projectStatus: 'Project status',
    cancelProjectConfirm: 'Mark this project cancelled?',
    cancelProjectTitle: 'Cancel this project?',
    cancelProjectAction: 'Cancel project',
    draftMismatch: 'This project is still a draft even though it already has a paid deposit or confirmed work. Set it to Active if work is proceeding.',
    appointments: 'Appointments',
    noAppointments: 'No appointments planned',
    calendar: 'Calendar',
    calendarHelp: 'How calendar sync works',
    calendarNotice: 'CRM is the schedule source of truth. Proposed appointments stay in CRM; each confirmed appointment shows its actual Google Calendar sync state above.',
  },
  ru: {
    deposit: 'Депозит',
    invoices: 'Счета',
    next: 'Следующий сеанс',
    projectStatus: 'Статус проекта',
    cancelProjectConfirm: 'Отметить этот проект отменённым?',
    cancelProjectTitle: 'Отменить проект?',
    cancelProjectAction: 'Отменить проект',
    draftMismatch: 'Проект всё ещё в черновике, хотя депозит уже оплачен или есть подтверждённая запись. Если работа идёт, переведи проект в статус «активный».',
    appointments: 'Записи',
    noAppointments: 'Записей пока нет',
    calendar: 'Календарь',
    calendarHelp: 'Как работает синхронизация календаря',
    calendarNotice: 'Расписание в CRM является основным. Предложенные записи остаются в CRM, а у каждой подтверждённой записи выше показывается фактический статус синхронизации с Google Calendar.',
  },
} as const;

/**
 * The project page is long: sessions, money, notes and activity. A row of
 * jump buttons under the header reaches each part in one tap. Buttons, not
 * links: the CRM routes with the URL hash, so a #fragment would navigate.
 */
function ProjectSectionNav({ ru, showNotes, showActivity }: { ru: boolean; showNotes: boolean; showActivity: boolean }) {
  const targets = [
    { id: 'project-sessions', label: ru ? 'Сеансы' : 'Sessions' },
    { id: 'project-money', label: ru ? 'Деньги' : 'Money' },
    ...(showNotes ? [{ id: 'project-notes', label: ru ? 'Заметки' : 'Notes' }] : []),
    ...(showActivity ? [{ id: 'project-activity', label: ru ? 'История' : 'Activity' }] : []),
  ];
  return (
    <nav className="section-jump" aria-label={ru ? 'Разделы проекта' : 'Project sections'}>
      {targets.map((target) => (
        <button
          key={target.id}
          type="button"
          className="section-jump-link"
          onClick={() => document.getElementById(target.id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
        >
          {target.label}
        </button>
      ))}
    </nav>
  );
}
