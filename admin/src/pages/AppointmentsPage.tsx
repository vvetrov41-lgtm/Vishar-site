import { useEffect, useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { AppointmentRow } from '../components/AppointmentRow';
import { appointmentDisplayStatus } from '../lib/appointment-display-status';
import { useAppointmentResponseRefresh } from '../lib/use-appointment-response-refresh';
import { BookingPanel } from '../components/BookingPanel';
import { ClientPicker } from '../components/ClientPicker';
import { MonthCalendarView, dayHeading, timeOffLabel } from '../components/MonthCalendarView';
import {
  WeekCalendarView,
  weekHeading,
  type WeekMoveRequest,
  type WeekResizeRequest,
} from '../components/WeekCalendarView';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { buildMonthCalendar, calendarMonthWindow, startOfLocalDay, startOfLocalMonth } from '../lib/calendar-month';
import {
  DEFAULT_TIMEZONE,
  addZonedDays,
  buildWeekCalendar,
  rescheduleTarget,
  resizeTarget,
  startOfZonedDay,
  startOfZonedWeek,
  zonedTimeLabel,
} from '../lib/calendar-week';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can, canManageArtistSessions } from '../lib/permissions';
import { useApi, useSession } from '../lib/session';
import type { AvailabilityBlock } from '../lib/availability-api';
import type { Client, Enquiry, Project, SessionStatus } from '../lib/types';
import type { Appointment, AppointmentType } from '../lib/appointment-api';
import './AppointmentsPage.css';

export { AppointmentRow, clientResponseLabel, typeLabel } from '../components/AppointmentRow';

type PageData = { appointments: Appointment[]; projects: Project[]; enquiries: Enquiry[]; clients: Client[]; timeOff: AvailabilityBlock[]; };
type TypeFilter = AppointmentType | 'all';
type CalendarView = 'month' | 'week' | 'day';
const TYPES: AppointmentType[] = ['tattoo_session', 'in_person_consultation', 'video_consultation', 'touch_up'];
const VIEWS: CalendarView[] = ['month', 'week', 'day'];

/** An appointment held at the position the operator dropped it on, until the server answers. */
interface OptimisticMove { appointmentId: string; startAt: string; endAt: string; }

export function AppointmentsPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { artists, selectedArtistId } = useArtistScope();
  const { language, label } = useLanguage();
  const copy = COPY[language];
  const mayManage = can(profile?.role, 'manageSessions');
  const [view, setView] = useState<CalendarView>('month');
  const [visibleMonth, setVisibleMonth] = useState(() => startOfLocalMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const monthWindow = useMemo(() => calendarMonthWindow(visibleMonth), [visibleMonth]);

  // The diary is the artist's, so its day boundaries are theirs. With no artist
  // chosen the installation's own zone is the honest default; the database has
  // every artist on Europe/London today.
  const timeZone = useMemo(() => {
    const scoped = artists.find((artist) => artist.id === selectedArtistId)
      ?? (artists.length === 1 ? artists[0] : null);
    return scoped?.timezone || DEFAULT_TIMEZONE;
  }, [artists, selectedArtistId]);

  const [anchor, setAnchor] = useState<number>(() => Date.now());
  const gridWindow = useMemo(() => {
    const days = view === 'day' ? 1 : 7;
    const start = days === 1
      ? startOfZonedDay(anchor, timeZone)
      : startOfZonedWeek(anchor, timeZone);
    return { start, end: startOfZonedDay(addZonedDays(start, days, timeZone), timeZone), days };
  }, [anchor, timeZone, view]);

  // Only the week and day grids bound the read. The month grid has always
  // loaded the unbounded window and is left exactly as it was.
  const readFrom = view === 'month' ? null : new Date(gridWindow.start).toISOString();
  const readTo = view === 'month' ? null : new Date(gridWindow.end).toISOString();

  const { data, loading, error, reload } = useAsync<PageData>(async () => {
    const [appointments, projects, enquiries] = await Promise.all([
      api.listAppointments({
        artistId: selectedArtistId ?? undefined,
        from: readFrom ?? undefined,
        to: readTo ?? undefined,
      }),
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
    const from = new Date(view === 'month' ? monthWindow.start : gridWindow.start).toISOString();
    const to = new Date(view === 'month' ? monthWindow.end : gridWindow.end).toISOString();
    const timeOff = (await Promise.all(
      calendarArtistIds.map((id) => api.listAvailabilityBlocks({ artistId: id, from, to }).catch(() => [])),
    )).flat();
    return { appointments, projects, enquiries, clients, timeOff };
  }, [api, selectedArtistId, view, monthWindow.start, monthWindow.end, gridWindow.start, gridWindow.end, readFrom, readTo]);

  useAppointmentResponseRefresh(reload);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [clientId, setClientId] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [changingAppointmentId, setChangingAppointmentId] = useState<string | null>(null);
  const [optimisticMove, setOptimisticMove] = useState<OptimisticMove | null>(null);

  // Fresh rows have arrived, so the held position has served its purpose.
  useEffect(() => { setOptimisticMove(null); }, [data]);

  const visibleAppointments = useMemo(() => {
    const rows = (data?.appointments ?? []).map((appointment) => (
      optimisticMove && optimisticMove.appointmentId === appointment.id
        ? { ...appointment, start_at: optimisticMove.startAt, end_at: optimisticMove.endAt }
        : appointment
    ));
    return typeFilter === 'all' ? rows : rows.filter((appointment) => appointment.appointment_type === typeFilter);
  }, [data?.appointments, optimisticMove, typeFilter]);

  if (loading && !data) return <LoadingState label={copy.loading} />;
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

  const week = buildWeekCalendar({
    anchor,
    now: nowDate,
    timeZone,
    days: gridWindow.days,
    appointments: visibleAppointments,
    timeOff: data.timeOff,
  });
  const artistNames: Record<string, string> = {};
  for (const artist of artists) artistNames[artist.id] = artist.display_name;

  async function changeStatus(appointmentId: string, status: SessionStatus) {
    setChangingAppointmentId(appointmentId);
    setStatusError(null);
    try { await api.setAppointmentStatus(appointmentId, status); reload(); }
    catch (cause) { setStatusError(cause instanceof Error ? cause.message : copy.statusFailed); }
    finally { setChangingAppointmentId(null); }
  }

  async function rescheduleAppointment(appointmentId: string, nextStartAt: string, nextEndAt: string) {
    setChangingAppointmentId(appointmentId);
    setStatusError(null);
    try { await api.rescheduleAppointment({ appointmentId, startAt: nextStartAt, endAt: nextEndAt }); reload(); }
    catch (cause) { setStatusError(cause instanceof Error ? cause.message : copy.rescheduleFailed); throw cause; }
    finally { setChangingAppointmentId(null); }
  }

  /**
   * A moved or resized appointment. The optimistic block reflects the proposed
   * window while the server decides; any conflict or refusal drops that hold
   * and the grid returns to the authoritative stored window.
   */
  async function applyAppointmentWindow(
    appointment: Appointment,
    target: { startAt: string; endAt: string },
    kind: 'move' | 'resize',
  ) {
    if (
      Date.parse(target.startAt) === Date.parse(appointment.start_at)
      && Date.parse(target.endAt) === Date.parse(appointment.end_at)
    ) return;
    // A second change while the first is still in flight would send another
    // reschedule for the same row and make the optimistic block ambiguous.
    if (changingAppointmentId !== null) return;

    setStatusError(null);
    setOptimisticMove({ appointmentId: appointment.id, startAt: target.startAt, endAt: target.endAt });
    setChangingAppointmentId(appointment.id);
    try {
      const conflicts = await api.listAppointmentConflicts({
        artistId: appointment.artist_id,
        startAt: target.startAt,
        endAt: target.endAt,
        excludeAppointmentId: appointment.id,
      });
      if (conflicts.length > 0) {
        setOptimisticMove(null);
        setStatusError(conflictMessage(
          conflicts[0].start_at,
          conflicts[0].end_at,
          timeZone,
          language,
          kind,
        ));
        return;
      }
      await api.rescheduleAppointment({
        appointmentId: appointment.id,
        startAt: target.startAt,
        endAt: target.endAt,
      });
      reload();
    } catch (cause) {
      setOptimisticMove(null);
      setStatusError(
        cause instanceof Error
          ? cause.message
          : (kind === 'resize' ? copy.resizeFailed : copy.rescheduleFailed)
      );
    } finally {
      setChangingAppointmentId(null);
    }
  }

  async function moveAppointment(request: WeekMoveRequest) {
    const target = rescheduleTarget({
      appointment: request.appointment,
      dayStart: request.dayStart,
      minutesFromMidnight: request.minutesFromMidnight,
      timeZone,
    });
    if (!target) return;
    await applyAppointmentWindow(request.appointment, target, 'move');
  }

  async function resizeAppointment(request: WeekResizeRequest) {
    const target = resizeTarget({
      appointment: request.appointment,
      endDayStart: request.endDayStart,
      endMinutesFromMidnight: request.endMinutesFromMidnight,
      timeZone,
    });
    if (!target) return;
    await applyAppointmentWindow(request.appointment, target, 'resize');
  }

  function moveGrid(offset: number) {
    setAnchor((current) => addZonedDays(current, offset * gridWindow.days, timeZone));
  }

  function moveMonth(offset: number) { const current = new Date(visibleMonth); setVisibleMonth(new Date(current.getFullYear(), current.getMonth() + offset, 1).getTime()); setSelectedDay(null); }
  function showToday() {
    const current = new Date();
    setVisibleMonth(startOfLocalMonth(current));
    setSelectedDay(startOfLocalDay(current));
    setAnchor(current.getTime());
  }

  // One card holds the controls and the grid they control. Two cards, titled
  // "Calendar" and then "Month", spent a heading saying what the button row
  // already said.
  const controls = (
        <div className="filters" style={{ marginBottom: 14 }}>
          <label><span>{copy.filterType}</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}><option value="all">{copy.allTypes}</option>{TYPES.map((type) => <option key={type} value={type}>{appointmentTypeLabel(type, language)}</option>)}</select></label>
          <div className="calendar-view-switch" role="group" aria-label={copy.viewLabel}>
            {VIEWS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                {copy[`view_${option}`]}
              </button>
            ))}
          </div>
        </div>
  );

  return (
    <>
      {statusError ? <p className="notice warn" role="alert">{statusError}</p> : null}
      {view === 'month' ? (
        <>
          <Section title={copy.title}>
            {controls}
            <MonthCalendarView month={month} visibleMonth={visibleMonth} selectedDay={effectiveSelectedDay} language={language} clients={data.clients} onSelectDay={setSelectedDay} onPreviousMonth={() => moveMonth(-1)} onNextMonth={() => moveMonth(1)} onToday={showToday} />
          </Section>
          <Section title={dayHeading(effectiveSelectedDay, language)}>
            <div className="calendar-selected-day">
              {!selectedCalendarDay || selectedCalendarDay.entries.length === 0 ? <EmptyState compact title={copy.dayFree} /> : selectedCalendarDay.entries.map((entry) => entry.kind === 'time_off' ? (
                <div key={entry.key} className="row calendar-time-off-detail"><div className="title">{timeOffLabel(entry.block.block_kind, language)}</div><div className="meta">{entry.block.is_all_day ? copy.allDay : `${formatDateTime(entry.block.start_at, language)} - ${formatDateTime(entry.block.end_at, language)}`}{entry.block.note ? ` · ${entry.block.note}` : ''}</div></div>
              ) : (
                <AppointmentRow key={entry.key} appointment={entry.appointment} client={data.clients.find((client) => client.id === entry.appointment.client_id) ?? null} enquiry={data.enquiries.find((enquiry) => enquiry.id === entry.appointment.enquiry_id) ?? null} project={data.projects.find((project) => project.id === entry.appointment.project_id) ?? null} language={language} statusLabel={label('sessionStatus', entry.appointment.status)} paymentLabel={label('paymentStatus', entry.appointment.payment_status)} mayManage={mayManage} changing={changingAppointmentId === entry.appointment.id} onStatus={(status) => { void changeStatus(entry.appointment.id, status); }} onReschedule={(nextStartAt, nextEndAt) => rescheduleAppointment(entry.appointment.id, nextStartAt, nextEndAt)} />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <Section title={copy.title}>
          {controls}
          <WeekCalendarView
            calendar={week}
            language={language}
            clients={data.clients}
            projects={data.projects}
            artistNames={artistNames}
            statusLabelFor={(appointment) => appointmentDisplayStatus(appointment, language, label('sessionStatus', appointment.status))}
            canMove={(appointment) => canManageArtistSessions(profile?.role, memberships, appointment.artist_id)}
            movingAppointmentId={changingAppointmentId}
            onMove={(request) => { void moveAppointment(request); }}
            onResize={(request) => { void resizeAppointment(request); }}
            onPrevious={() => moveGrid(-1)}
            onNext={() => moveGrid(1)}
            onToday={showToday}
            heading={weekHeading(week, language)}
          />
          <p className="meta">{copy.timeZoneNote.replace('{zone}', timeZone)}</p>
        </Section>
      )}
      {mayManage ? <Section title={copy.findTime}>{!bookingArtistId ? <p className="meta">{copy.chooseArtistFirst}</p> : clientId ? <BookingPanel artistId={bookingArtistId} clientId={clientId} clientName={clientName(data.clients, clientId) ?? copy.thisClient} projectOptions={data.projects.filter((project) => project.client_id === clientId).map((project) => ({ id: project.id, label: project.title, enquiryId: project.enquiry_id }))} enquiryOptions={data.enquiries.filter((enquiry) => enquiry.client_id === clientId).map((enquiry) => ({ id: enquiry.id, label: enquiry.reference_number }))} onBooked={() => reload()} /> : <div className="client-picker-field"><span className="client-picker-heading">{copy.whoFor}</span><ClientPicker value={clientId} language={language} inputId="smart-booking-client-search" onChange={setClientId} /></div>}</Section> : null}
    </>
  );
}
function clientName(clients: Client[], clientId: string): string | null { return clients.find((client) => client.id === clientId)?.full_name ?? null; }
function conflictMessage(
  startAt: string,
  endAt: string,
  timeZone: string,
  language: Language,
  kind: 'move' | 'resize',
): string {
  const window = `${zonedTimeLabel(startAt, timeZone)}–${zonedTimeLabel(endAt, timeZone)}`;
  const template = kind === 'resize' ? COPY[language].resizeConflict : COPY[language].conflict;
  return template.replace('{window}', window);
}
function appointmentTypeLabel(type: AppointmentType, language: Language): string { const labels: Record<Language, Record<AppointmentType, string>> = { en: { tattoo_session: 'Tattoo session', in_person_consultation: 'In-person consultation', video_consultation: 'Video consultation', touch_up: 'Touch-up' }, ru: { tattoo_session: 'Тату-сеанс', in_person_consultation: 'Очная консультация', video_consultation: 'Видеоконсультация', touch_up: 'Коррекция' } }; return labels[language][type]; }
const COPY: Record<Language, Record<string, string>> = { en: { title:'Calendar', loading:'Loading appointments…', none:'No appointments yet', filterType:'Filter by type', allTypes:'All appointment types', viewLabel:'Calendar view', view_month:'Month', view_week:'Week', view_day:'Day', monthView:'Month', weekView:'Week', dayView:'Day', dayFree:'Nothing booked', allDay:'All day', findTime:'Find a time', chooseArtistFirst:'Choose an artist above to search for free times.', whoFor:'Who is this for?', thisClient:'this client', statusFailed:'Could not change that appointment.', rescheduleFailed:'Could not reschedule that appointment.', resizeFailed:'Could not change that appointment duration.', conflict:'That time is already taken ({window}). The appointment has not moved.', resizeConflict:'That duration overlaps another appointment ({window}). The duration has not changed.', timeZoneNote:'Times are shown in {zone}.' }, ru: { title:'Календарь', loading:'Загрузка записей…', none:'Записей пока нет', filterType:'Фильтр по типу', allTypes:'Все типы записей', viewLabel:'Вид календаря', view_month:'Месяц', view_week:'Неделя', view_day:'День', monthView:'Месяц', weekView:'Неделя', dayView:'День', dayFree:'Записей нет', allDay:'Весь день', findTime:'Подобрать время', chooseArtistFirst:'Выберите мастера выше, чтобы искать свободное время.', whoFor:'Для кого?', thisClient:'этот клиент', statusFailed:'Не удалось изменить статус записи.', rescheduleFailed:'Не удалось перенести запись.', resizeFailed:'Не удалось изменить длительность записи.', conflict:'Это время уже занято ({window}). Запись осталась на месте.', resizeConflict:'Новая длительность пересекается с другой записью ({window}). Длительность не изменена.', timeZoneNote:'Время показано в зоне {zone}.' } };
