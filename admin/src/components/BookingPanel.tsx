import { useMemo, useState, type FormEvent } from 'react';
import { EmptyState } from './StateViews';
import {
  appointmentFamily,
  conflictPolicyFor,
  dayWindowFor,
  findAvailableSlots,
  findConsecutiveDaySlots,
  type Slot,
} from '../lib/availability';
import {
  bookingErrorCode,
  bookingErrorMessage,
  isSlotConflict,
  type BookingErrorCode,
} from '../lib/booking-errors';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { AppointmentType } from '../lib/appointment-api';
import type { BookingConflict, ScheduleOverride, SchedulingPreferences } from '../lib/scheduling-api';

const DURATION_MINUTES: Record<AppointmentType, number[]> = {
  tattoo_session: [180, 240, 300, 360, 420],
  in_person_consultation: [15, 20, 30],
  video_consultation: [15, 20, 30],
  touch_up: [60, 120, 180],
};

const SEARCH_DAYS = 21;
const MANUAL_STEP_MINUTES = 5;

export interface BookingLinkOption {
  id: string;
  label: string;
  enquiryId?: string | null;
}

export interface BookingPanelProps {
  artistId: string | null;
  clientId: string;
  clientName: string;
  enquiryId?: string | null;
  projectId?: string | null;
  projectOptions?: BookingLinkOption[];
  enquiryOptions?: BookingLinkOption[];
  onBooked: (appointmentId: string | null) => void;
}

type Stage = 'search' | 'chosen';

export function BookingPanel({
  artistId,
  clientId,
  clientName,
  enquiryId = null,
  projectId = null,
  projectOptions,
  enquiryOptions,
  onBooked,
}: BookingPanelProps) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];

  const [appointmentType, setAppointmentType] = useState<AppointmentType>('tattoo_session');
  const [durationMinutes, setDurationMinutes] = useState(420);
  const [preferences, setPreferences] = useState<SchedulingPreferences | null>(null);
  const [overrides, setOverrides] = useState<ScheduleOverride[]>([]);
  const [conflicts, setConflicts] = useState<BookingConflict[] | null>(null);
  const [fromDate, setFromDate] = useState(() => todayValue());
  const [consecutiveDays, setConsecutiveDays] = useState(1);

  const [stage, setStage] = useState<Stage>('search');
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [series, setSeries] = useState<Slot[][] | null>(null);
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [searching, setSearching] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chosenProjectId, setChosenProjectId] = useState('');
  const [chosenEnquiryId, setChosenEnquiryId] = useState('');
  const [manual, setManual] = useState(false);
  const [manualStart, setManualStart] = useState('');
  const [manualEnd, setManualEnd] = useState('');
  const [checkingConflicts, setCheckingConflicts] = useState(false);

  const blocking = (conflicts ?? []).filter((conflict) => conflict.blocks);
  const alongside = (conflicts ?? []).filter((conflict) => !conflict.blocks);
  const durations = DURATION_MINUTES[appointmentType];
  const wantsProject = appointmentFamily(appointmentType) === 'tattoo';
  const soleProjectId = projectOptions?.length === 1 ? projectOptions[0].id : null;
  const soleEnquiryId = enquiryOptions?.length === 1 ? enquiryOptions[0].id : null;
  const defaultProjectId = wantsProject ? soleProjectId : null;
  const defaultEnquiryId = wantsProject && !soleProjectId ? soleEnquiryId : null;
  const selectedProjectId = chosenProjectId || defaultProjectId || '';
  const effectiveProjectId = projectId ?? (selectedProjectId || null);
  const chosenProject = (projectOptions ?? []).find((option) => option.id === selectedProjectId);
  const selectedEnquiryId = chosenEnquiryId || defaultEnquiryId || '';
  const effectiveEnquiryId = enquiryId ?? chosenProject?.enquiryId ?? (selectedEnquiryId || null);
  const derivesProject = wantsProject && appointmentType !== 'touch_up' && !!effectiveEnquiryId;
  const projectMissing = wantsProject && !effectiveProjectId && !derivesProject;
  const projectMissingCode: BookingErrorCode = appointmentType === 'touch_up'
    ? 'TOUCH_UP_PROJECT_REQUIRED'
    : 'PROJECT_REQUIRED';
  const grouped = useMemo(() => groupByDay(slots ?? []), [slots]);

  function updateDuration(nextMinutes: number) {
    setDurationMinutes(nextMinutes);
    if (manualStart) setManualEnd(addMinutesLocal(manualStart, nextMinutes));
    setSlots(null);
    setSeries(null);
    setConflicts(null);
  }

  function updateManualStart(rawValue: string) {
    const nextStart = snapLocalDateTime(rawValue, MANUAL_STEP_MINUTES);
    setManualStart(nextStart);
    setManualEnd(nextStart ? addMinutesLocal(nextStart, durationMinutes) : '');
    setConflicts(null);
  }

  function toggleManual() {
    setManual((current) => {
      const next = !current;
      if (next && !manualStart) {
        const start = snapLocalDateTime(toLocalDateTimeValue(new Date()), MANUAL_STEP_MINUTES, 'ceil');
        setManualStart(start);
        setManualEnd(addMinutesLocal(start, durationMinutes));
      }
      return next;
    });
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setChosen(null);
    setSeries(null);
    setStage('search');
    if (!artistId) {
      setError(copy.chooseArtist);
      return;
    }
    setSearching(true);
    try {
      const from = new Date(`${fromDate}T00:00:00`);
      const to = new Date(from);
      to.setDate(to.getDate() + SEARCH_DAYS);
      const [appointments, timeOff, prefs, dayOverrides] = await Promise.all([
        api.listAppointments({ artistId }),
        api.listAvailabilityBlocks({ artistId, from: from.toISOString(), to: to.toISOString() }),
        api.getSchedulingPreferences(artistId),
        api.listScheduleOverrides({ artistId, from: dayValue(from), to: dayValue(to) })
          .catch(() => [] as ScheduleOverride[]),
      ]);
      setPreferences(prefs);
      setOverrides(dayOverrides);
      const overrideByDay = new Map(dayOverrides.map((entry) => [entry.on_date, entry]));
      const search = {
        now: new Date(),
        from,
        to,
        durationMinutes,
        dayWindow: dayWindowFor(appointmentType, prefs, undefined),
        windowForDay: (day: string) => dayWindowFor(appointmentType, prefs, overrideByDay.get(day)),
        policy: conflictPolicyFor(appointmentType, prefs),
        preferredStarts: appointmentFamily(appointmentType) === 'tattoo' ? prefs.tattoo_preferred_starts : [],
        appointments,
        timeOff,
        limit: 24,
        granularityMinutes: durationMinutes >= 180 ? 60 : 30,
      };
      if (consecutiveDays > 1) {
        const runs = findConsecutiveDaySlots(search, consecutiveDays);
        setSeries(runs);
        setSlots(runs.flat());
      } else {
        setSlots(findAvailableSlots(search));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.searchFailed);
      setSlots(null);
    } finally {
      setSearching(false);
    }
  }

  async function checkManualConflicts(startAt: string, endAt: string) {
    if (!artistId) return;
    setCheckingConflicts(true);
    try {
      setConflicts(await api.listBookingConflicts({ artistId, appointmentType, startAt, endAt }));
    } catch {
      setConflicts(null);
    } finally {
      setCheckingConflicts(false);
    }
  }

  function manualTimes(): { start: string; end: string } | null {
    const normalizedStart = snapLocalDateTime(manualStart, MANUAL_STEP_MINUTES);
    if (!normalizedStart) return null;
    const normalizedEnd = addMinutesLocal(normalizedStart, durationMinutes);
    const start = new Date(normalizedStart);
    const end = new Date(normalizedEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
    return { start: start.toISOString(), end: end.toISOString() };
  }

  async function book(startAt: string, endAt: string) {
    if (!artistId) {
      setError(copy.chooseArtist);
      return;
    }
    if (projectMissing) {
      setError(bookingErrorMessage(projectMissingCode, language));
      return;
    }
    setBooking(true);
    setError(null);
    try {
      const result = await api.scheduleAppointment({
        artistId,
        clientId,
        appointmentType,
        startAt,
        endAt,
        enquiryId: effectiveEnquiryId,
        projectId: effectiveProjectId,
      });
      onBooked(result.appointment_id);
      setStage('search');
      setChosen(null);
      setSlots(null);
      setSeries(null);
      setConflicts(null);
      setNotice(
        result.replayed
          ? copy.alreadyBooked
          : result.project_created
            ? `${copy.projectCreated} ${copy.booked}`
            : copy.booked
      );
    } catch (cause) {
      const code = bookingErrorCode(cause);
      setError(code ? bookingErrorMessage(code, language) : cause instanceof Error ? cause.message : copy.bookFailed);
      if (isSlotConflict(code)) {
        setSlots(null);
        setSeries(null);
      }
      setStage('search');
      setChosen(null);
    } finally {
      setBooking(false);
    }
  }

  return (
    <div className="booking-panel">
      <form onSubmit={(event) => { void runSearch(event); }}>
        <div className="form-grid">
          <label>
            <span>{copy.type}</span>
            <select
              value={appointmentType}
              onChange={(event) => {
                const next = event.target.value as AppointmentType;
                const nextDuration = DURATION_MINUTES[next][DURATION_MINUTES[next].length - 1];
                setAppointmentType(next);
                updateDuration(nextDuration);
              }}
            >
              <option value="tattoo_session">{copy.types.tattoo_session}</option>
              <option value="in_person_consultation">{copy.types.in_person_consultation}</option>
              <option value="video_consultation">{copy.types.video_consultation}</option>
              <option value="touch_up">{copy.types.touch_up}</option>
            </select>
          </label>
          <label>
            <span>{copy.from}</span>
            <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
          </label>
        </div>

        {!projectId && (projectOptions?.length ?? 0) > 0 ? (
          <label>
            <span>{copy.project}{wantsProject ? '' : ` · ${copy.optional}`}</span>
            <select value={selectedProjectId} onChange={(event) => { setChosenProjectId(event.target.value); setSlots(null); }}>
              {defaultProjectId ? null : <option value="">{copy.noProject}</option>}
              {(projectOptions ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        ) : null}

        {!enquiryId && !chosenProject?.enquiryId && (enquiryOptions?.length ?? 0) > 0 ? (
          <label>
            <span>{copy.enquiry} · {copy.optional}</span>
            <select value={selectedEnquiryId} onChange={(event) => setChosenEnquiryId(event.target.value)}>
              {defaultEnquiryId ? null : <option value="">{copy.noEnquiry}</option>}
              {(enquiryOptions ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        ) : null}

        {projectMissing ? <p className="notice warn" role="status">{bookingErrorMessage(projectMissingCode, language)}</p> : null}

        <div className="actions" aria-label={copy.durationShortcuts}>
          {durations.map((minutes) => (
            <button
              key={minutes}
              type="button"
              aria-pressed={durationMinutes === minutes}
              className={durationMinutes === minutes ? 'selected' : undefined}
              onClick={() => updateDuration(minutes)}
            >
              {durationLabel(minutes, language)}
            </button>
          ))}
        </div>

        <label>
          <span>{copy.days}</span>
          <select value={consecutiveDays} onChange={(event) => setConsecutiveDays(Number(event.target.value))}>
            <option value={1}>{copy.oneSession}</option>
            <option value={2}>{copy.twoDays}</option>
            <option value={3}>{copy.threeDays}</option>
          </select>
        </label>

        {preferences ? (
          <p className="meta booking-window-note">
            {copy.windowNote
              .replace('{from}', windowLabel(preferences, appointmentType, 'start'))
              .replace('{to}', windowLabel(preferences, appointmentType, 'finish'))}
            {overrides.length > 0 ? ` ${copy.overridesApplied.replace('{count}', String(overrides.length))}` : ''}
          </p>
        ) : null}

        <div className="actions">
          <button type="submit" className="primary" disabled={searching || !artistId}>{searching ? copy.searching : copy.search}</button>
          <button type="button" onClick={toggleManual}>{manual ? copy.hideManual : copy.showManual}</button>
        </div>
      </form>

      {error ? <p className="notice warn" role="alert">{error}</p> : null}
      {notice ? <p className="notice ok" role="status">{notice}</p> : null}

      {stage === 'chosen' && chosen ? (
        <div className="booking-summary" role="group" aria-label={copy.summary}>
          <p className="booking-summary-line">
            {copy.summaryLine
              .replace('{type}', copy.types[appointmentType])
              .replace('{client}', clientName)
              .replace('{date}', formatDateTime(chosen.start, language))
              .replace('{duration}', durationLabel(durationMinutes, language))}
          </p>
          <div className="actions">
            <button type="button" className="primary" disabled={booking} onClick={() => { void book(chosen.start, chosen.end); }}>
              {booking ? copy.booking : copy.confirm}
            </button>
            <button type="button" disabled={booking} onClick={() => { setStage('search'); setChosen(null); }}>{copy.chooseAnother}</button>
          </div>
        </div>
      ) : null}

      {series && stage === 'search' ? (
        series.length === 0 ? <EmptyState title={copy.noSeries} hint={copy.noSeriesHint} /> : (
          <div className="list booking-slots">
            {series.map((run) => (
              <button key={run.map((slot) => slot.start).join('|')} type="button" className="row booking-slot" onClick={() => { setChosen(run[0]); setStage('chosen'); }}>
                <span className="title">{run.map((slot) => formatDateTime(slot.start, language)).join(' · ')}</span>
                <span className="meta">{copy.seriesHint.replace('{count}', String(run.length))}</span>
              </button>
            ))}
          </div>
        )
      ) : null}

      {slots && !series && stage === 'search' ? (
        slots.length === 0 ? <EmptyState title={copy.noSlots} hint={copy.noSlotsHint} /> : (
          <div className="booking-days">
            {grouped.map(([day, daySlots]) => (
              <section key={day} className="booking-day">
                <h4>{dayHeading(day, language)}</h4>
                <div className="list booking-slots">
                  {daySlots.map((slot) => (
                    <button key={slot.start} type="button" className="row booking-slot" onClick={() => { setChosen(slot); setStage('chosen'); }}>
                      <span className="title">{timeLabel(slot.start, language)}</span>
                      <span className="meta">
                        {copy.roomFree.replace('{room}', durationLabel(slot.availableMinutes, language))}
                        {slot.availableMinutes === durationMinutes ? ` · ${copy.exactFit}` : ''}
                        {slot.preferred ? ` · ${copy.preferredStart}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
      ) : null}

      {manual ? (
        <div className="booking-manual">
          <p className="meta">{copy.manualHint}</p>
          <p className="meta">{copy.manualDuration.replace('{duration}', durationLabel(durationMinutes, language))}</p>
          <div className="form-grid">
            <label>
              <span>{copy.start}</span>
              <input
                type="datetime-local"
                step={MANUAL_STEP_MINUTES * 60}
                value={manualStart}
                onChange={(event) => updateManualStart(event.target.value)}
              />
            </label>
            <label>
              <span>{copy.end}</span>
              <input
                type="datetime-local"
                step={MANUAL_STEP_MINUTES * 60}
                value={manualEnd}
                readOnly
                aria-readonly="true"
              />
            </label>
          </div>
          {checkingConflicts ? <p className="meta">{copy.checking}</p> : null}
          {blocking.length > 0 ? <p className="notice warn" role="alert">{copy.wouldClash.replace('{count}', String(blocking.length))}</p> : null}
          {alongside.length > 0 ? <p className="notice" role="status">{copy.alsoThen.replace('{count}', String(alongside.length))}</p> : null}
          <div className="actions">
            <button
              type="button"
              disabled={booking || !manualStart}
              onClick={() => {
                const times = manualTimes();
                if (!times) { setError(copy.manualInvalid); return; }
                void checkManualConflicts(times.start, times.end);
              }}
            >
              {copy.checkTime}
            </button>
            <button
              type="button"
              className={blocking.length > 0 ? undefined : 'primary'}
              disabled={booking || !manualStart}
              onClick={() => {
                const times = manualTimes();
                if (!times) { setError(copy.manualInvalid); return; }
                void book(times.start, times.end);
              }}
            >
              {copy.bookManual}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function dayValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function windowLabel(preferences: SchedulingPreferences, type: AppointmentType, edge: 'start' | 'finish'): string {
  if (appointmentFamily(type) === 'consultation') {
    return edge === 'start' ? preferences.consultation_earliest_start : preferences.consultation_latest_finish;
  }
  return edge === 'start' ? preferences.tattoo_earliest_start : preferences.tattoo_latest_finish;
}

function todayValue(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function groupByDay(slots: Slot[]): [string, Slot[]][] {
  const days = new Map<string, Slot[]>();
  for (const slot of slots) {
    const bucket = days.get(slot.day) ?? [];
    bucket.push(slot);
    days.set(slot.day, bucket);
  }
  return [...days.entries()];
}

function dayHeading(day: string, language: Language): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function timeLabel(iso: string, language: Language): string {
  return new Date(iso).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function durationLabel(minutes: number, language: Language): string {
  if (minutes < 60) return language === 'ru' ? `${minutes} мин` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursPart = language === 'ru' ? `${hours} ч` : `${hours} h`;
  if (rest === 0) return hoursPart;
  return language === 'ru' ? `${hoursPart} ${rest} мин` : `${hoursPart} ${rest} min`;
}

function toLocalDateTimeValue(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function snapLocalDateTime(value: string, stepMinutes = MANUAL_STEP_MINUTES, mode: 'nearest' | 'ceil' = 'nearest'): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const minute = date.getMinutes();
  const remainder = minute % stepMinutes;
  if (remainder !== 0) {
    const delta = mode === 'ceil'
      ? stepMinutes - remainder
      : remainder < stepMinutes / 2 ? -remainder : stepMinutes - remainder;
    date.setMinutes(minute + delta);
  }
  date.setSeconds(0, 0);
  return toLocalDateTimeValue(date);
}

export function addMinutesLocal(value: string, minutes: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  date.setMinutes(date.getMinutes() + minutes);
  return toLocalDateTimeValue(date);
}

const COPY = {
  en: {
    type: 'Appointment type', durationShortcuts: 'Common durations', from: 'Search from', days: 'How many days',
    oneSession: 'One session', twoDays: 'Two days in a row', threeDays: 'Three days in a row',
    windowNote: 'Searching this artist’s hours: {from} to {to}.', overridesApplied: '{count} day(s) in range have their own hours.', preferredStart: 'usual start',
    project: 'Project', enquiry: 'Enquiry', optional: 'optional', noProject: 'No project', noEnquiry: 'No enquiry',
    search: 'Find free times', searching: 'Looking…', searchFailed: 'Could not check the schedule.', chooseArtist: 'Choose an artist first.',
    noSlots: 'Nothing that long is free', noSlotsHint: 'Try a shorter session, a wider hours window, or a later start date.',
    noSeries: 'No run of days that long is free', noSeriesHint: 'Try two days instead of three, a shorter session, or a later start date.',
    seriesHint: '{count} days in a row', roomFree: '{room} free here', exactFit: 'exact fit',
    summary: 'Booking summary', summaryLine: '{type} for {client}, {date}, {duration}.', confirm: 'Book it', booking: 'Booking…', chooseAnother: 'Choose another time',
    bookFailed: 'Could not book that appointment.', showManual: 'Enter a time myself', hideManual: 'Hide manual entry',
    manualHint: 'Choose the start in 5-minute steps. The end is calculated from the selected duration.',
    manualDuration: 'Selected duration: {duration}.', start: 'Start', end: 'End', bookManual: 'Book this exact time',
    manualInvalid: 'Choose a valid start time.', booked: 'Booked. It is proposed until the client confirms it.', projectCreated: 'Project created.',
    alreadyBooked: 'That appointment was already booked. Nothing was duplicated.', checkTime: 'Check this time', checking: 'Checking the schedule…',
    wouldClash: 'This clashes with {count} booking(s) and will be refused.', alsoThen: '{count} other appointment(s) happen then. They do not block this one.',
    types: { tattoo_session: 'Tattoo session', in_person_consultation: 'In-person consultation', video_consultation: 'Video consultation', touch_up: 'Touch-up' },
  },
  ru: {
    type: 'Тип записи', durationShortcuts: 'Частые длительности', from: 'Искать с', days: 'Сколько дней',
    oneSession: 'Один сеанс', twoDays: 'Два дня подряд', threeDays: 'Три дня подряд',
    windowNote: 'Ищем в часах мастера: с {from} до {to}.', overridesApplied: 'У {count} дн. в этом диапазоне свои часы.', preferredStart: 'обычное начало',
    project: 'Проект', enquiry: 'Заявка', optional: 'необязательно', noProject: 'Без проекта', noEnquiry: 'Без заявки',
    search: 'Найти свободное время', searching: 'Ищем…', searchFailed: 'Не удалось проверить расписание.', chooseArtist: 'Сначала выберите мастера.',
    noSlots: 'Столько свободного времени нет', noSlotsHint: 'Попробуйте более короткий сеанс, более широкое окно часов или более позднюю дату.',
    noSeries: 'Столько дней подряд не свободно', noSeriesHint: 'Попробуйте два дня вместо трёх, более короткий сеанс или более позднюю дату.',
    seriesHint: '{count} дня подряд', roomFree: 'здесь свободно {room}', exactFit: 'впритык',
    summary: 'Итог записи', summaryLine: '{type} для {client}, {date}, {duration}.', confirm: 'Записать', booking: 'Записываем…', chooseAnother: 'Выбрать другое время',
    bookFailed: 'Не удалось создать запись.', showManual: 'Ввести время вручную', hideManual: 'Скрыть ручной ввод',
    manualHint: 'Выберите начало с шагом 5 минут. Конец рассчитывается автоматически по выбранной длительности.',
    manualDuration: 'Выбранная длительность: {duration}.', start: 'Начало', end: 'Конец', bookManual: 'Записать на это время',
    manualInvalid: 'Выберите корректное время начала.', booked: 'Записано. Запись предварительная, пока клиент не подтвердит.', projectCreated: 'Проект создан.',
    alreadyBooked: 'Эта запись уже создана. Дубль не появился.', checkTime: 'Проверить это время', checking: 'Проверяем расписание…',
    wouldClash: 'Пересекается с {count} записью(ями) - такая запись будет отклонена.', alsoThen: 'В это же время есть ещё {count} запись(и). Они не мешают.',
    types: { tattoo_session: 'Тату-сеанс', in_person_consultation: 'Очная консультация', video_consultation: 'Видеоконсультация', touch_up: 'Коррекция' },
  },
} as const;
