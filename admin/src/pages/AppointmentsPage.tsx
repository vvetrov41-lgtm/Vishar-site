import { useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { BookingPanel } from '../components/BookingPanel';
import { ClientPicker } from '../components/ClientPicker';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { beyondAgenda, buildAgenda, pastAppointments } from '../lib/calendar-agenda';
import { calendarSyncLabel } from '../lib/calendar-sync';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can } from '../lib/permissions';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import type { AvailabilityBlock } from '../lib/availability-api';
import type { Client, Enquiry, Project, SessionStatus } from '../lib/types';
import type {
  Appointment,
  AppointmentClientResponse,
  AppointmentType,
} from '../lib/appointment-api';

type PageData = {
  appointments: Appointment[];
  projects: Project[];
  enquiries: Enquiry[];
  clients: Client[];
  timeOff: AvailabilityBlock[];
};

/** How far ahead the diary lays out days, including today. */
const AGENDA_DAYS = 14;

type TypeFilter = AppointmentType | 'all';

const TYPES: AppointmentType[] = [
  'tattoo_session',
  'in_person_consultation',
  'video_consultation',
  'touch_up',
];


export function AppointmentsPage() {
  const api = useApi();
  const { profile } = useSession();
  const { artists, selectedArtistId } = useArtistScope();
  const { language, label } = useLanguage();
  const copy = COPY[language];
  const mayManage = can(profile?.role, 'manageSessions');

  const { data, loading, error, reload } = useAsync<PageData>(async () => {
    const [appointments, projects, enquiries] = await Promise.all([
      api.listAppointments({ artistId: selectedArtistId ?? undefined }),
      api.listProjects(undefined, selectedArtistId ?? undefined),
      api.listEnquiries({ artistId: selectedArtistId ?? undefined }),
    ]);

    // Names for exactly the people on this screen. Listing the 200 newest
    // clients instead would silently fail to name an older one on their own
    // appointment.
    const clients = await api.listClientsByIds([
      ...appointments.map((appointment) => appointment.client_id),
      ...projects.map((project) => project.client_id),
      ...enquiries.map((enquiry) => enquiry.client_id),
    ]);

    // Time off is the other half of "when am I free?", and lived on a separate
    // screen. The read is per artist, so with no artist chosen it asks about
    // every artist the operator can reach rather than showing an empty diary.
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + AGENDA_DAYS).toISOString();
    const agendaArtistIds = selectedArtistId
      ? [selectedArtistId]
      : (await api.listAccessibleArtists()).filter((artist) => artist.is_active).map((artist) => artist.id);
    const timeOff = (await Promise.all(
      agendaArtistIds.map((id) => api.listAvailabilityBlocks({ artistId: id, from, to }).catch(() => [])),
    )).flat();

    return { appointments, projects, enquiries, clients, timeOff };
  }, [api, selectedArtistId]);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [clientId, setClientId] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [changingAppointmentId, setChangingAppointmentId] = useState<string | null>(null);

  // The Calendar now only needs to know who the shared panel is booking for.
  // Project and enquiry linking, duration, manual entry and the clash warning
  // all moved into that panel.
  const resolvedClientId = clientId;
  // One reachable artist means there is no choice to make, so the panel must
  // not sit behind a selector the operator has no reason to touch. This is the
  // same inference Payments makes, for the same reason.
  const bookingArtistId = selectedArtistId
    ?? (artists.length === 1 ? artists[0].id : null);

  const visibleAppointments = useMemo(() => {
    const rows = data?.appointments ?? [];
    return typeFilter === 'all'
      ? rows
      : rows.filter((appointment) => appointment.appointment_type === typeFilter);
  }, [data?.appointments, typeFilter]);

  if (loading) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={copy.none} />;

  const nowDate = new Date();
  const agenda = buildAgenda({
    now: nowDate,
    appointments: visibleAppointments,
    timeOff: data.timeOff,
    days: AGENDA_DAYS,
  });
  const later = beyondAgenda(nowDate, AGENDA_DAYS, visibleAppointments);
  const past = pastAppointments(nowDate, visibleAppointments);

  async function changeStatus(appointmentId: string, status: SessionStatus) {
    setChangingAppointmentId(appointmentId);
    setStatusError(null);
    try {
      await api.setAppointmentStatus(appointmentId, status);
      reload();
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : copy.statusFailed);
    } finally {
      setChangingAppointmentId(null);
    }
  }
  async function rescheduleAppointment(appointmentId: string, nextStartAt: string, nextEndAt: string) {
    setChangingAppointmentId(appointmentId);
    setStatusError(null);
    try {
      await api.rescheduleAppointment({ appointmentId, startAt: nextStartAt, endAt: nextEndAt });
      reload();
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : copy.rescheduleFailed);
      throw cause;
    } finally {
      setChangingAppointmentId(null);
    }
  }

  return (
    <>
      <Section title={copy.title}>
        <div className="filters">
          <label>
            <span>{copy.filterType}</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}>
              <option value="all">{copy.allTypes}</option>
              {TYPES.map((type) => (
                <option key={type} value={type}>{typeLabel(type, language)}</option>
              ))}
            </select>
          </label>
        </div>
      </Section>

      {/* The primary way to book: say who and how long, and be offered times
          that are actually free. The detailed form below stays as the advanced
          path - it is the only place that links a booking to a project or an
          enquiry, and the only one that can deliberately book over a clash. */}
      {mayManage ? (
        <Section title={copy.findTime}>
          {!bookingArtistId ? (
            // Hiding the panel until an artist is chosen would repeat the
            // Payments defect: a screen that needs a selection and gives no
            // sign it is waiting for one.
            <p className="meta">{copy.chooseArtistFirst}</p>
          ) : resolvedClientId ? (
            <BookingPanel
              artistId={bookingArtistId}
              clientId={resolvedClientId}
              clientName={clientName(data?.clients ?? [], resolvedClientId) ?? copy.thisClient}
              projectOptions={(data?.projects ?? [])
                .filter((project) => project.client_id === resolvedClientId)
                .map((project) => ({
                  id: project.id,
                  label: project.title,
                  enquiryId: project.enquiry_id,
                }))}
              enquiryOptions={(data?.enquiries ?? [])
                .filter((enquiry) => enquiry.client_id === resolvedClientId)
                .map((enquiry) => ({ id: enquiry.id, label: enquiry.reference_number }))}
              // The client stays chosen: a large piece is booked as several
              // sessions, and clearing the picker would also throw away the
              // confirmation the panel just rendered.
              onBooked={() => reload()}
            />
          ) : (
            <div className="client-picker-field">
              <span className="client-picker-heading">{copy.whoFor}</span>
              <ClientPicker
                value={resolvedClientId}
                language={language}
                inputId="smart-booking-client-search"
                onChange={setClientId}
              />
            </div>
          )}
        </Section>
      ) : null}

      {/* The detailed form that used to live here is gone. Everything it did -
          project and enquiry linking, duration shortcuts, manual date entry,
          and the pre-submit clash warning - now lives in the shared panel
          above, so there is one booking behaviour rather than two that had
          already started to drift. */}

      {statusError ? <p className="notice warn" role="alert">{statusError}</p> : null}

      {/* The diary, not a flat list. Every day in the window appears, including
          the empty ones, because "nothing on Thursday" is the answer to "when
          am I free?" - and time off, the other half of that answer, is shown
          here rather than on a separate screen. */}
      <Section title={copy.diary}>
        <div className="agenda">
          {agenda.map((day) => (
            <div key={day.date} className={day.isToday ? 'agenda-day today' : 'agenda-day'}>
              <h3 className="agenda-day-heading">
                {dayHeading(day.date, language)}
                {day.isToday ? <span className="badge ok">{copy.todayMarker}</span> : null}
              </h3>
              {day.entries.length === 0 ? (
                <p className="meta agenda-free">{copy.dayFree}</p>
              ) : (
                <div className="list">
                  {day.entries.map((entry) => (entry.kind === 'time_off' ? (
                    <div key={entry.key} className="row agenda-time-off">
                      <div className="title">{timeOffLabel(entry.block.block_kind, language)}</div>
                      <div className="meta">
                        {entry.block.is_all_day
                          ? copy.allDay
                          : `${formatDateTime(entry.block.start_at, language)} – ${formatDateTime(entry.block.end_at, language)}`}
                        {entry.block.note ? ` · ${entry.block.note}` : ''}
                      </div>
                    </div>
                  ) : (
                    <AppointmentRow
                      key={entry.key}
                      appointment={entry.appointment}
                      client={data.clients.find((client) => client.id === entry.appointment.client_id) ?? null}
                      enquiry={data.enquiries.find((enquiry) => enquiry.id === entry.appointment.enquiry_id) ?? null}
                      project={data.projects.find((project) => project.id === entry.appointment.project_id) ?? null}
                      language={language}
                      statusLabel={label('sessionStatus', entry.appointment.status)}
                      paymentLabel={label('paymentStatus', entry.appointment.payment_status)}
                      mayManage={mayManage}
                      changing={changingAppointmentId === entry.appointment.id}
                      onStatus={(status) => { void changeStatus(entry.appointment.id, status); }}
                      onReschedule={(nextStartAt, nextEndAt) => rescheduleAppointment(entry.appointment.id, nextStartAt, nextEndAt)}
                    />
                  )))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title={copy.later}>
        {later.length === 0 ? <EmptyState compact title={copy.nothingLater} /> : (
          <div className="list">
            {later.map((appointment) => (
              <AppointmentRow
                key={appointment.id}
                appointment={appointment}
                client={data.clients.find((client) => client.id === appointment.client_id) ?? null}
                enquiry={data.enquiries.find((enquiry) => enquiry.id === appointment.enquiry_id) ?? null}
                project={data.projects.find((project) => project.id === appointment.project_id) ?? null}
                language={language}
                statusLabel={label('sessionStatus', appointment.status)}
                paymentLabel={label('paymentStatus', appointment.payment_status)}
                mayManage={mayManage}
                changing={changingAppointmentId === appointment.id}
                onStatus={(status) => { void changeStatus(appointment.id, status); }}
                onReschedule={(nextStartAt, nextEndAt) => rescheduleAppointment(appointment.id, nextStartAt, nextEndAt)}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title={copy.past}>
        {past.length === 0 ? <EmptyState title={copy.noPast} /> : (
          <div className="list">
            {past.slice(0, 50).map((appointment) => (
              <AppointmentRow
                key={appointment.id}
                appointment={appointment}
                client={data.clients.find((client) => client.id === appointment.client_id) ?? null}
                enquiry={data.enquiries.find((enquiry) => enquiry.id === appointment.enquiry_id) ?? null}
                project={data.projects.find((project) => project.id === appointment.project_id) ?? null}
                language={language}
                statusLabel={label('sessionStatus', appointment.status)}
                paymentLabel={label('paymentStatus', appointment.payment_status)}
                mayManage={mayManage}
                changing={changingAppointmentId === appointment.id}
                onStatus={(status) => { void changeStatus(appointment.id, status); }}
                onReschedule={(nextStartAt, nextEndAt) => rescheduleAppointment(appointment.id, nextStartAt, nextEndAt)}
              />
            ))}
          </div>
        )}
      </Section>

      <p className="notice">{copy.calendarNotice}</p>
    </>
  );
}

export function AppointmentRow({
  appointment,
  client,
  enquiry,
  project,
  language,
  statusLabel,
  paymentLabel,
  mayManage,
  changing,
  onStatus,
  onReschedule,
}: {
  appointment: Appointment;
  client: Client | null;
  enquiry: Enquiry | null;
  project: Project | null;
  language: Language;
  statusLabel: string;
  paymentLabel: string;
  mayManage: boolean;
  changing: boolean;
  onStatus: (status: SessionStatus) => void;
  onReschedule: (startAt: string, endAt: string) => Promise<void>;
}) {
  const copy = COPY[language];
  const appointmentName = `${typeLabel(appointment.appointment_type, language)} · ${formatDateTime(appointment.start_at, language)}`;
  const isActive = ['draft', 'proposed', 'confirmed'].includes(appointment.status);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [nextStartAt, setNextStartAt] = useState(toDateTimeLocal(new Date(appointment.start_at)));
  const [nextEndAt, setNextEndAt] = useState(toDateTimeLocal(new Date(appointment.end_at)));
  const nextStartIso = inputToIso(nextStartAt);
  const nextEndIso = inputToIso(nextEndAt);
  const rescheduleValid = Boolean(nextStartIso && nextEndIso && nextEndIso > nextStartIso);

  return (
    <div className="row">
      <div className="title">{formatDateTime(appointment.start_at, language)}</div>
      <div className="meta">
        <span className="badge">{typeLabel(appointment.appointment_type, language)}</span>{' '}
        <span className={appointment.status === 'confirmed' ? 'badge ok' : 'badge'}>{statusLabel}</span>{' '}
        {appointment.client_response ? (
          <span className={appointment.client_response === 'reschedule_requested' ? 'badge warn' : 'badge ok'}>
            {clientResponseLabel(appointment.client_response, language)}
            {appointment.client_response_at ? ` · ${formatDateTime(appointment.client_response_at, language)}` : ''}
          </span>
        ) : null}{' '}
        <span className="badge">{durationValue(appointment.duration_hours, language)}</span>{' '}
        <span className="badge">{paymentLabel}</span>{' '}
        <span className={appointment.calendar_sync_status === 'failed' ? 'badge warn' : 'badge'}>
          {copy.calendar}: {calendarSyncLabel(appointment, language)}
        </span>
      </div>
      <div className="meta" style={{ marginTop: 8 }}>
        {client ? (
          <Link to={`/clients/${client.id}`} className="badge">{copy.client}: {client.full_name}</Link>
        ) : null}{' '}
        {enquiry ? (
          <Link to={`/enquiries/${enquiry.id}`} className="badge">{copy.enquiry}: {enquiry.reference_number}</Link>
        ) : null}{' '}
        {project ? (
          <Link to={`/projects/${project.id}`} className="badge">{copy.project}: {project.title}</Link>
        ) : (
          <span className="badge">{copy.noProject}</span>
        )}
      </div>
      {mayManage && isActive ? (
        <>
          <div className="actions">
            <button
              type="button"
              disabled={changing}
              aria-expanded={rescheduleOpen}
              onClick={() => setRescheduleOpen((open) => !open)}
            >
              {copy.reschedule}
            </button>
          {['draft', 'proposed'].includes(appointment.status) ? (
            <button
              type="button"
              disabled={changing}
              aria-label={`${copy.confirm}: ${appointmentName}`}
              onClick={() => onStatus('confirmed')}
            >
              {copy.confirm}
            </button>
          ) : null}
          {appointment.status === 'confirmed' ? (
            <>
              <button
                type="button"
                disabled={changing}
                aria-label={`${copy.markCompleted}: ${appointmentName}`}
                onClick={() => onStatus('completed')}
              >
                {copy.markCompleted}
              </button>
              <button
                type="button"
                disabled={changing}
                aria-label={`${copy.markNoShow}: ${appointmentName}`}
                onClick={() => onStatus('no_show')}
              >
                {copy.markNoShow}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="danger"
            disabled={changing}
            aria-label={`${copy.cancel}: ${appointmentName}`}
            onClick={() => onStatus('cancelled')}
          >
            {copy.cancel}
          </button>
          </div>
          {rescheduleOpen ? (
            <div className="notice" style={{ marginTop: 12 }}>
              <div className="form-grid">
                <label>
                  <span>{copy.newStart}</span>
                  <input type="datetime-local" value={nextStartAt} onChange={(event) => setNextStartAt(event.target.value)} />
                </label>
                <label>
                  <span>{copy.newEnd}</span>
                  <input type="datetime-local" value={nextEndAt} onChange={(event) => setNextEndAt(event.target.value)} />
                </label>
              </div>
              <div className="actions">
                <button
                  type="button"
                  disabled={changing || !rescheduleValid}
                  onClick={() => {
                    if (!nextStartIso || !nextEndIso) return;
                    void onReschedule(nextStartIso, nextEndIso).then(() => setRescheduleOpen(false));
                  }}
                >
                  {changing ? copy.saving : copy.saveReschedule}
                </button>
                <button type="button" disabled={changing} onClick={() => setRescheduleOpen(false)}>
                  {copy.goBack}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const DAY_HEADING: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
  ru: new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }),
};

function dayHeading(date: number, language: Language): string {
  return DAY_HEADING[language].format(new Date(date));
}

function timeOffLabel(kind: AvailabilityBlock['block_kind'], language: Language): string {
  const labels: Record<Language, Record<AvailabilityBlock['block_kind'], string>> = {
    en: { day_off: 'Day off', holiday: 'Holiday', personal: 'Personal', other: 'Unavailable' },
    ru: { day_off: 'Выходной', holiday: 'Отпуск', personal: 'Личное', other: 'Недоступно' },
  };
  return labels[language][kind];
}

/**
 * A picker option names the person first. `Raven sleeve` and `ENQ-2026-0143`
 * both identify a record; neither tells the operator who they are booking.
 */
function clientName(clients: Client[], clientId: string): string | null {
  return clients.find((client) => client.id === clientId)?.full_name ?? null;
}


export function typeLabel(type: AppointmentType, language: Language): string {
  return TYPE_LABELS[language][type];
}

export function clientResponseLabel(response: AppointmentClientResponse, language: Language): string {
  const labels: Record<Language, Record<AppointmentClientResponse, string>> = {
    en: {
      attendance_confirmed: 'Client confirmed',
      reschedule_requested: 'Client requested reschedule',
    },
    ru: {
      attendance_confirmed: 'Клиент подтвердил',
      reschedule_requested: 'Клиент просит перенос',
    },
  };
  return labels[language][response];
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

function inputToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toDateTimeLocal(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const TYPE_LABELS: Record<Language, Record<AppointmentType, string>> = {
  en: {
    tattoo_session: 'Tattoo session',
    in_person_consultation: 'In-person consultation',
    video_consultation: 'Video consultation',
    touch_up: 'Touch-up',
  },
  ru: {
    tattoo_session: 'Тату-сеанс',
    in_person_consultation: 'Очная консультация',
    video_consultation: 'Видеоконсультация',
    touch_up: 'Коррекция',
  },
};

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Calendar',
    loading: 'Loading appointments…',
    none: 'No appointments yet',
    filterType: 'Filter by type',
    allTypes: 'All appointment types',
    newAppointment: 'New appointment',
    findTime: 'Find a time',
    chooseArtistFirst: 'Choose an artist above to search for free times.',
    whoFor: 'Who is this for?',
    thisClient: 'this client',
    type: 'Appointment type',
    project: 'Project',
    enquiry: 'Enquiry',
    client: 'Client',
    required: 'required',
    optional: 'optional',
    noProject: 'No project',
    noEnquiry: 'No enquiry',
    chooseClient: 'Choose a client',
    chooseArtist: 'Choose an artist above before creating a client-only consultation.',
    projectRequired: 'Tattoo sessions and touch-ups require a project.',
    start: 'Start',
    end: 'End',
    notes: 'Internal appointment note',
    durationShortcuts: 'Duration shortcuts',
    checkingConflicts: 'Checking the artist schedule…',
    conflicts: 'Conflicting active appointments: {count}. The first starts {date}.',
    bookAnyway: 'I mean to book over this clash',
    booked: '{type} booked for {client}, {date}. It is proposed until you confirm it.',
    openBooking: 'Open it',
    completeRequired: 'Choose valid links, a start time and a later end time.',
    saveFailed: 'Could not schedule that appointment.',
    statusFailed: 'Could not change that appointment.',
    rescheduleFailed: 'Could not reschedule that appointment.',
    reschedule: 'Reschedule',
    newStart: 'New start',
    newEnd: 'New end',
    saveReschedule: 'Save new time',
    goBack: 'Go back',
    saving: 'Saving…',
    propose: 'Propose appointment',
    confirm: 'Confirm',
    markCompleted: 'Mark completed',
    markNoShow: 'Mark no-show',
    cancel: 'Cancel',
    diary: 'Next 14 days',
    todayMarker: 'Today',
    dayFree: 'Nothing booked',
    allDay: 'All day',
    later: 'Further ahead',
    nothingLater: 'Nothing booked beyond the next 14 days',
    past: 'Past',
    noPast: 'No past appointments',
    calendarNotice: 'Supabase remains authoritative. Calendar delivery stays queued or disconnected until the artist Google Calendar route is connected.',
    calendar: 'Calendar',
  },
  ru: {
    title: 'Календарь',
    loading: 'Загрузка записей…',
    none: 'Записей пока нет',
    filterType: 'Фильтр по типу',
    allTypes: 'Все типы записей',
    newAppointment: 'Новая запись',
    findTime: 'Подобрать время',
    chooseArtistFirst: 'Выберите мастера выше, чтобы искать свободное время.',
    whoFor: 'Для кого?',
    thisClient: 'этот клиент',
    type: 'Тип записи',
    project: 'Проект',
    enquiry: 'Заявка',
    client: 'Клиент',
    required: 'обязательно',
    optional: 'необязательно',
    noProject: 'Без проекта',
    noEnquiry: 'Без заявки',
    chooseClient: 'Выберите клиента',
    chooseArtist: 'Для консультации без проекта сначала выберите мастера сверху.',
    projectRequired: 'Для тату-сеанса и коррекции обязателен проект.',
    start: 'Начало',
    end: 'Окончание',
    notes: 'Внутренняя заметка к записи',
    durationShortcuts: 'Быстрый выбор длительности',
    checkingConflicts: 'Проверяем расписание мастера…',
    conflicts: 'Пересекающихся активных записей: {count}. Первая начинается {date}.',
    bookAnyway: 'Я осознанно записываю поверх пересечения',
    booked: '{type} для {client} записан на {date}. Запись предложена и ждёт подтверждения.',
    openBooking: 'Открыть',
    completeRequired: 'Выберите корректные связи, начало и более позднее окончание.',
    saveFailed: 'Не удалось создать запись.',
    statusFailed: 'Не удалось изменить статус записи.',
    rescheduleFailed: 'Не удалось перенести запись.',
    reschedule: 'Перенести',
    newStart: 'Новое начало',
    newEnd: 'Новое окончание',
    saveReschedule: 'Сохранить новое время',
    goBack: 'Назад',
    saving: 'Сохраняем…',
    propose: 'Предложить запись',
    confirm: 'Подтвердить',
    markCompleted: 'Завершить',
    markNoShow: 'Не пришёл',
    cancel: 'Отменить',
    diary: 'Ближайшие 14 дней',
    todayMarker: 'Сегодня',
    dayFree: 'Записей нет',
    allDay: 'Весь день',
    later: 'Дальше',
    nothingLater: 'После ближайших 14 дней записей нет',
    past: 'Прошедшие',
    noPast: 'Прошедших записей нет',
    calendarNotice: 'Supabase остаётся источником данных. Отправка в календарь будет ждать подключения Google Calendar выбранного мастера.',
    calendar: 'Календарь',
  },
};
