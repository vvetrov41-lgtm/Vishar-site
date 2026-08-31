import { useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { AppointmentRow } from '../components/AppointmentRow';
import { BookingPanel } from '../components/BookingPanel';
import { ClientPicker } from '../components/ClientPicker';
import { MonthCalendarView, dayHeading, timeOffLabel } from '../components/MonthCalendarView';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { buildMonthCalendar, calendarMonthWindow, startOfLocalDay, startOfLocalMonth } from '../lib/calendar-month';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can } from '../lib/permissions';
import { useApi, useSession } from '../lib/session';
import type { AvailabilityBlock } from '../lib/availability-api';
import type { Client, Enquiry, Project, SessionStatus } from '../lib/types';
import type { Appointment, AppointmentType } from '../lib/appointment-api';
import './AppointmentsPage.css';

export { AppointmentRow, clientResponseLabel, typeLabel } from '../components/AppointmentRow';

type PageData = {
  appointments: Appointment[];
  projects: Project[];
  enquiries: Enquiry[];
  clients: Client[];
  timeOff: AvailabilityBlock[];
};

type TypeFilter = AppointmentType | 'all';
const TYPES: AppointmentType[] = ['tattoo_session', 'in_person_consultation', 'video_consultation', 'touch_up'];

export function AppointmentsPage() {
  const api = useApi();
  const { profile } = useSession();
  const { artists, selectedArtistId } = useArtistScope();
  const { language, label } = useLanguage();
  const copy = COPY[language];
  const mayManage = can(profile?.role, 'manageSessions');
  const [visibleMonth, setVisibleMonth] = useState(() => startOfLocalMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const monthWindow = useMemo(() => calendarMonthWindow(visibleMonth), [visibleMonth]);

  const { data, loading, error, reload } = useAsync<PageData>(async () => {
    const [appointments, projects, enquiries] = await Promise.all([
      api.listAppointments({ artistId: selectedArtistId ?? undefined }),
      api.listProjects(undefined, selectedArtistId ?? undefined),
      api.listEnquiries({ artistId: selectedArtistId ?? undefined }),
    ]);
    const clients = await api.listClientsByIds([
      ...appointments.map((appointment) => appointment.client_id),
      ...projects.map((project) => project.client_id),
      ...enquiries.map((enquiry) => enquiry.client_id),
    ]);
    const calendarArtistIds = selectedArtistId
      ? [selectedArtistId]
      : (await api.listAccessibleArtists()).filter((artist) => artist.is_active).map((artist) => artist.id);
    const from = new Date(monthWindow.start).toISOString();
    const to = new Date(monthWindow.end).toISOString();
    const timeOff = (await Promise.all(
      calendarArtistIds.map((id) => api.listAvailabilityBlocks({ artistId: id, from, to }).catch(() => [])),
    )).flat();
    return { appointments, projects, enquiries, clients, timeOff };
  }, [api, selectedArtistId, monthWindow.start, monthWindow.end]);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [clientId, setClientId] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [changingAppointmentId, setChangingAppointmentId] = useState<string | null>(null);
  const visibleAppointments = useMemo(() => {
    const rows = data?.appointments ?? [];
    return typeFilter === 'all' ? rows : rows.filter((appointment) => appointment.appointment_type === typeFilter);
  }, [data?.appointments, typeFilter]);

  if (loading) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={copy.none} />;

  const nowDate = new Date();
  const month = buildMonthCalendar({ month: visibleMonth, now: nowDate, appointments: visibleAppointments, timeOff: data.timeOff });
  const today = startOfLocalDay(nowDate);
  const defaultSelectedDay = month.days.find((day) => day.date === today && day.entries.length > 0)?.date
    ?? month.days.find((day) => day.date >= today && day.entries.length > 0)?.date
    ?? month.days.find((day) => day.date === today)?.date
    ?? startOfLocalMonth(visibleMonth);
  const effectiveSelectedDay = selectedDay !== null && month.days.some((day) => day.date === selectedDay)
    ? selectedDay
    : defaultSelectedDay;
  const selectedCalendarDay = month.days.find((day) => day.date === effectiveSelectedDay) ?? null;
  const bookingArtistId = selectedArtistId ?? (artists.length === 1 ? artists[0].id : null);

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

  function moveMonth(offset: number) {
    const current = new Date(visibleMonth);
    setVisibleMonth(new Date(current.getFullYear(), current.getMonth() + offset, 1).getTime());
    setSelectedDay(null);
  }

  function showToday() {
    const current = new Date();
    setVisibleMonth(startOfLocalMonth(current));
    setSelectedDay(startOfLocalDay(current));
  }

  return (
    <>
      <Section title={copy.title}>
        <div className="filters">
          <label>
            <span>{copy.filterType}</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}>
              <option value="all">{copy.allTypes}</option>
              {TYPES.map((type) => <option key={type} value={type}>{appointmentTypeLabel(type, language)}</option>)}
            </select>
          </label>
        </div>
      </Section>

      {statusError ? <p className="notice warn" role="alert">{statusError}</p> : null}

      <Section title={copy.monthView}>
        <MonthCalendarView
          month={month}
          visibleMonth={visibleMonth}
          selectedDay={effectiveSelectedDay}
          language={language}
          clients={data.clients}
          onSelectDay={setSelectedDay}
          onPreviousMonth={() => moveMonth(-1)}
          onNextMonth={() => moveMonth(1)}
          onToday={showToday}
        />
      </Section>

      <Section title={dayHeading(effectiveSelectedDay, language)}>
        <div className="calendar-selected-day">
          {!selectedCalendarDay || selectedCalendarDay.entries.length === 0 ? (
            <EmptyState compact title={copy.dayFree} />
          ) : selectedCalendarDay.entries.map((entry) => entry.kind === 'time_off' ? (
            <div key={entry.key} className="row calendar-time-off-detail">
              <div className="title">{timeOffLabel(entry.block.block_kind, language)}</div>
              <div className="meta">
                {entry.block.is_all_day
                  ? copy.allDay
                  : `${formatDateTime(entry.block.start_at, language)} - ${formatDateTime(entry.block.end_at, language)}`}
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
          ))}
        </div>
      </Section>

      {mayManage ? (
        <Section title={copy.findTime}>
          {!bookingArtistId ? (
            <p className="meta">{copy.chooseArtistFirst}</p>
          ) : clientId ? (
            <BookingPanel
              artistId={bookingArtistId}
              clientId={clientId}
              clientName={clientName(data.clients, clientId) ?? copy.thisClient}
              projectOptions={data.projects
                .filter((project) => project.client_id === clientId)
                .map((project) => ({ id: project.id, label: project.title, enquiryId: project.enquiry_id }))}
              enquiryOptions={data.enquiries
                .filter((enquiry) => enquiry.client_id === clientId)
                .map((enquiry) => ({ id: enquiry.id, label: enquiry.reference_number }))}
              onBooked={() => reload()}
            />
          ) : (
            <div className="client-picker-field">
              <span className="client-picker-heading">{copy.whoFor}</span>
              <ClientPicker value={clientId} language={language} inputId="smart-booking-client-search" onChange={setClientId} />
            </div>
          )}
        </Section>
      ) : null}

      <p className="notice">{copy.calendarNotice}</p>
    </>
  );
}

function clientName(clients: Client[], clientId: string): string | null {
  return clients.find((client) => client.id === clientId)?.full_name ?? null;
}

function appointmentTypeLabel(type: AppointmentType, language: Language): string {
  const labels: Record<Language, Record<AppointmentType, string>> = {
    en: { tattoo_session: 'Tattoo session', in_person_consultation: 'In-person consultation', video_consultation: 'Video consultation', touch_up: 'Touch-up' },
    ru: { tattoo_session: 'Тату-сеанс', in_person_consultation: 'Очная консультация', video_consultation: 'Видеоконсультация', touch_up: 'Коррекция' },
  };
  return labels[language][type];
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Calendar', loading: 'Loading appointments…', none: 'No appointments yet',
    filterType: 'Filter by type', allTypes: 'All appointment types', monthView: 'Month',
    dayFree: 'Nothing booked', allDay: 'All day', findTime: 'Find a time',
    chooseArtistFirst: 'Choose an artist above to search for free times.', whoFor: 'Who is this for?', thisClient: 'this client',
    statusFailed: 'Could not change that appointment.', rescheduleFailed: 'Could not reschedule that appointment.',
    calendarNotice: 'Supabase remains authoritative. Calendar delivery stays queued or disconnected until the artist Google Calendar route is connected.',
  },
  ru: {
    title: 'Календарь', loading: 'Загрузка записей…', none: 'Записей пока нет',
    filterType: 'Фильтр по типу', allTypes: 'Все типы записей', monthView: 'Месяц',
    dayFree: 'Записей нет', allDay: 'Весь день', findTime: 'Подобрать время',
    chooseArtistFirst: 'Выберите мастера выше, чтобы искать свободное время.', whoFor: 'Для кого?', thisClient: 'этот клиент',
    statusFailed: 'Не удалось изменить статус записи.', rescheduleFailed: 'Не удалось перенести запись.',
    calendarNotice: 'Supabase остаётся источником данных. Отправка в календарь будет ждать подключения Google Calendar выбранного мастера.',
  },
};
