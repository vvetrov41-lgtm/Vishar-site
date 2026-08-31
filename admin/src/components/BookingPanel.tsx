// One booking flow, reachable from wherever the operator realises they need it.
//
// Before this, booking meant opening the Calendar, reading a list of
// appointments, working out where a seven-hour gap was, and typing two
// datetimes. On a phone that is not a workflow, it is arithmetic.
//
// The panel asks for what the operator actually knows - who, what kind, how
// long - and answers with times that are genuinely free. The rules behind
// "free" are the database's own (see lib/availability.ts); this component only
// asks and renders.
//
// Two things are deliberate:
//
//   - the working window is no longer asked on every search. It comes from
//     the artist's stored scheduling preferences (0120) with per-day
//     overrides applied, so a seven-hour piece is offered as 09:00-16:00 or
//     11:00-18:00 - the starts this studio actually uses - without anybody
//     retyping them. The preferences are edited in Settings, not here.
//   - manual entry stays, and now carries a real pre-submit conflict check.
//     Smart search answers "when could I fit this?", and that is most
//     bookings but not all: rescheduling to a time the client already named,
//     or booking outside the usual hours, is still typing two datetimes.

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
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { AppointmentType } from '../lib/appointment-api';
import type { BookingConflict, ScheduleOverride, SchedulingPreferences } from '../lib/scheduling-api';

/**
 * Reuses the per-type durations the Calendar already offers, plus the two the
 * studio asked for by name. A duration list is a convenience, not a rule: any
 * length can still be typed.
 */
const DURATION_MINUTES: Record<AppointmentType, number[]> = {
  tattoo_session: [180, 240, 300, 360, 420],
  in_person_consultation: [15, 20, 30],
  video_consultation: [15, 20, 30],
  touch_up: [60, 120, 180],
};

const SEARCH_DAYS = 21;

export interface BookingLinkOption {
  id: string;
  label: string;
  /** Set when choosing this project also fixes the enquiry it came from. */
  enquiryId?: string | null;
}

export interface BookingPanelProps {
  artistId: string | null;
  clientId: string;
  clientName: string;
  /** Fixed by the calling screen. When absent, the panel offers a picker. */
  enquiryId?: string | null;
  projectId?: string | null;
  /**
   * Projects this booking may be attached to. A tattoo session belongs to a
   * project - that is where the estimate, the deposit and the other sessions
   * live - so when the client has one, tattoo work must name it. A client with
   * no project yet can still be booked, because refusing that would make a new
   * client unbookable.
   */
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
  const [warning, setWarning] = useState<string | null>(null);
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
  // A caller that fixed the link wins; otherwise whatever the operator chose.
  const effectiveProjectId = projectId ?? (chosenProjectId || null);
  const chosenProject = (projectOptions ?? []).find((option) => option.id === chosenProjectId);
  const effectiveEnquiryId = enquiryId
    ?? chosenProject?.enquiryId
    ?? (chosenEnquiryId || null);
  const wantsProject = appointmentFamily(appointmentType) === 'tattoo';
  const projectMissing = wantsProject
    && !effectiveProjectId
    && (projectOptions?.length ?? 0) > 0;

  const grouped = useMemo(() => groupByDay(slots ?? []), [slots]);

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setWarning(null);
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

      // Every input is an authoritative server read: listAppointments is
      // RLS-filtered, and the preference, override and time-off RPCs are all
      // SECURITY DEFINER behind require_artist_access. Nothing about "free" is
      // decided from anything the browser made up.
      const [appointments, timeOff, prefs, dayOverrides] = await Promise.all([
        api.listAppointments({ artistId }),
        api.listAvailabilityBlocks({
          artistId,
          from: from.toISOString(),
          to: to.toISOString(),
        }),
        api.getSchedulingPreferences(artistId),
        api.listScheduleOverrides({
          artistId,
          from: dayValue(from),
          to: dayValue(to),
        }).catch(() => [] as ScheduleOverride[]),
      ]);
      setPreferences(prefs);
      setOverrides(dayOverrides);

      const overrideByDay = new Map(dayOverrides.map((entry) => [entry.on_date, entry]));
      const search = {
        now: new Date(),
        from,
        to,
        durationMinutes,
        // The artist's own boundary, not a number typed into this form.
        dayWindow: dayWindowFor(appointmentType, prefs, undefined),
        windowForDay: (day: string) => dayWindowFor(appointmentType, prefs, overrideByDay.get(day)),
        // The policy the database will apply at write time, applied here so
        // the panel cannot offer a time the booking would then refuse.
        policy: conflictPolicyFor(appointmentType, prefs),
        preferredStarts: appointmentFamily(appointmentType) === 'tattoo'
          ? prefs.tattoo_preferred_starts
          : [],
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

  /**
   * What else is in the diary at a manually typed time, and whether it would
   * refuse the booking. Asked of the database, using the same policy the write
   * path enforces - so this cannot warn about something the booking would
   * happily accept, or stay silent about something it would refuse.
   */
  async function checkManualConflicts(startAt: string, endAt: string) {
    if (!artistId) return;
    setCheckingConflicts(true);
    try {
      setConflicts(await api.listBookingConflicts({
        artistId,
        appointmentType,
        startAt,
        endAt,
      }));
    } catch {
      // A failed advisory read must not block a booking the database will
      // check anyway. It just means no warning is shown.
      setConflicts(null);
    } finally {
      setCheckingConflicts(false);
    }
  }

  function manualTimes(): { start: string; end: string } | null {
    const start = new Date(manualStart);
    const end = new Date(manualEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
    return { start: start.toISOString(), end: end.toISOString() };
  }

  async function book(startAt: string, endAt: string) {
    if (!artistId) {
      setError(copy.chooseArtist);
      return;
    }
    if (projectMissing) {
      setError(copy.projectRequired);
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
      const appointmentId = typeof result?.appointment_id === 'string' ? result.appointment_id : null;
      onBooked(appointmentId);
      setStage('search');
      setChosen(null);
      setSlots(null);
      setSeries(null);
      setConflicts(null);
      setNotice(copy.booked);
    } catch (cause) {
      // The database holds the schedule lock and re-checks availability inside
      // the booking transaction, so a slot that went stale between being
      // offered and being confirmed is refused here rather than double-booked.
      // Re-searching is the honest recovery, so say so.
      setError(cause instanceof Error ? cause.message : copy.bookFailed);
      setWarning(copy.staleSlot);
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
                setAppointmentType(next);
                setDurationMinutes(DURATION_MINUTES[next][DURATION_MINUTES[next].length - 1]);
                setSlots(null);
              }}
            >
              <option value="tattoo_session">{copy.types.tattoo_session}</option>
              <option value="in_person_consultation">{copy.types.in_person_consultation}</option>
              <option value="video_consultation">{copy.types.video_consultation}</option>
              <option value="touch_up">{copy.types.touch_up}</option>
            </select>
          </label>

          <label>
            <span>{copy.duration}</span>
            <input
              type="number"
              min={15}
              max={720}
              step={15}
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(Number(event.target.value) || 15)}
            />
          </label>
        </div>

        {/* Only where the calling screen has not already fixed the link. A
            booking opened from a project is already that project's. */}
        {!projectId && (projectOptions?.length ?? 0) > 0 ? (
          <label>
            <span>{copy.project}{wantsProject ? '' : ` · ${copy.optional}`}</span>
            <select
              value={chosenProjectId}
              onChange={(event) => { setChosenProjectId(event.target.value); setSlots(null); }}
            >
              <option value="">{copy.noProject}</option>
              {(projectOptions ?? []).map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        ) : null}

        {!enquiryId && !chosenProject?.enquiryId && (enquiryOptions?.length ?? 0) > 0 ? (
          <label>
            <span>{copy.enquiry} · {copy.optional}</span>
            <select
              value={chosenEnquiryId}
              onChange={(event) => setChosenEnquiryId(event.target.value)}
            >
              <option value="">{copy.noEnquiry}</option>
              {(enquiryOptions ?? []).map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        ) : null}

        {projectMissing ? (
          <p className="notice warn" role="status">{copy.projectRequired}</p>
        ) : null}

        <div className="actions" aria-label={copy.durationShortcuts}>
          {durations.map((minutes) => (
            <button
              key={minutes}
              type="button"
              aria-pressed={durationMinutes === minutes}
              className={durationMinutes === minutes ? 'selected' : undefined}
              onClick={() => setDurationMinutes(minutes)}
            >
              {durationLabel(minutes, language)}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <label>
            <span>{copy.from}</span>
            <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
          </label>

          <label>
            <span>{copy.days}</span>
            <select
              value={consecutiveDays}
              onChange={(event) => setConsecutiveDays(Number(event.target.value))}
            >
              <option value={1}>{copy.oneSession}</option>
              <option value={2}>{copy.twoDays}</option>
              <option value={3}>{copy.threeDays}</option>
            </select>
          </label>
        </div>

        {/* The window comes from the artist, not from this form. Saying which
            window is being searched keeps the result explainable; changing it
            belongs in Settings, where it persists. */}
        {preferences ? (
          <p className="meta booking-window-note">
            {copy.windowNote
              .replace('{from}', windowLabel(preferences, appointmentType, 'start'))
              .replace('{to}', windowLabel(preferences, appointmentType, 'finish'))}
            {overrides.length > 0 ? ` ${copy.overridesApplied.replace('{count}', String(overrides.length))}` : ''}
          </p>
        ) : null}

        <div className="actions">
          <button type="submit" className="primary" disabled={searching || !artistId}>
            {searching ? copy.searching : copy.search}
          </button>
          <button type="button" onClick={() => setManual((value) => !value)}>
            {manual ? copy.hideManual : copy.showManual}
          </button>
        </div>
      </form>

      {error ? <p className="notice warn" role="alert">{error}</p> : null}
      {warning ? <p className="notice warn" role="status">{warning}</p> : null}
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
            <button
              type="button"
              className="primary"
              disabled={booking}
              onClick={() => { void book(chosen.start, chosen.end); }}
            >
              {booking ? copy.booking : copy.confirm}
            </button>
            <button type="button" disabled={booking} onClick={() => { setStage('search'); setChosen(null); }}>
              {copy.chooseAnother}
            </button>
          </div>
        </div>
      ) : null}

      {series && stage === 'search' ? (
        series.length === 0 ? (
          <EmptyState title={copy.noSeries} hint={copy.noSeriesHint} />
        ) : (
          <div className="list booking-slots">
            {series.map((run) => (
              <button
                key={run.map((slot) => slot.start).join('|')}
                type="button"
                className="row booking-slot"
                onClick={() => { setChosen(run[0]); setStage('chosen'); }}
              >
                <span className="title">
                  {run.map((slot) => formatDateTime(slot.start, language)).join(' · ')}
                </span>
                <span className="meta">{copy.seriesHint.replace('{count}', String(run.length))}</span>
              </button>
            ))}
          </div>
        )
      ) : null}

      {slots && !series && stage === 'search' ? (
        slots.length === 0 ? (
          <EmptyState title={copy.noSlots} hint={copy.noSlotsHint} />
        ) : (
          <div className="booking-days">
            {grouped.map(([day, daySlots]) => (
              <section key={day} className="booking-day">
                <h4>{dayHeading(day, language)}</h4>
                <div className="list booking-slots">
                  {daySlots.map((slot) => (
                    <button
                      key={slot.start}
                      type="button"
                      className="row booking-slot"
                      onClick={() => { setChosen(slot); setStage('chosen'); }}
                    >
                      <span className="title">{timeLabel(slot.start, language)}</span>
                      {/* Why this is valid, in the operator's terms: how much
                          room the gap actually has, so they can offer more. */}
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
          <div className="form-grid">
            <label>
              <span>{copy.start}</span>
              <input
                type="datetime-local"
                value={manualStart}
                onChange={(event) => setManualStart(event.target.value)}
              />
            </label>
            <label>
              <span>{copy.end}</span>
              <input
                type="datetime-local"
                value={manualEnd}
                onChange={(event) => setManualEnd(event.target.value)}
              />
            </label>
          </div>
          {checkingConflicts ? <p className="meta">{copy.checking}</p> : null}

          {/* What else is happening then, split by whether it would actually
              refuse the booking. A consultation running alongside a tattoo
              session is worth knowing about and is not an obstacle. */}
          {blocking.length > 0 ? (
            <p className="notice warn" role="alert">
              {copy.wouldClash.replace('{count}', String(blocking.length))}
            </p>
          ) : null}
          {alongside.length > 0 ? (
            <p className="notice" role="status">
              {copy.alsoThen.replace('{count}', String(alongside.length))}
            </p>
          ) : null}

          <div className="actions">
            <button
              type="button"
              disabled={booking || !manualStart || !manualEnd}
              onClick={() => {
                const times = manualTimes();
                if (!times) {
                  setError(copy.manualInvalid);
                  return;
                }
                void checkManualConflicts(times.start, times.end);
              }}
            >
              {copy.checkTime}
            </button>
            <button
              type="button"
              className={blocking.length > 0 ? undefined : 'primary'}
              // The database refuses a real clash regardless; disabling here
              // would only hide why. It stays pressable and the warning says
              // what will happen.
              disabled={booking || !manualStart || !manualEnd}
              onClick={() => {
                const times = manualTimes();
                if (!times) {
                  setError(copy.manualInvalid);
                  return;
                }
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


/** Local day key for a date, matching the override table's `on_date`. */
function dayValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function windowLabel(
  preferences: SchedulingPreferences,
  type: AppointmentType,
  edge: 'start' | 'finish',
): string {
  if (appointmentFamily(type) === 'consultation') {
    return edge === 'start'
      ? preferences.consultation_earliest_start
      : preferences.consultation_latest_finish;
  }
  return edge === 'start'
    ? preferences.tattoo_earliest_start
    : preferences.tattoo_latest_finish;
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
  return new Date(`${day}T00:00:00`).toLocaleDateString(
    language === 'ru' ? 'ru-RU' : 'en-GB',
    { weekday: 'long', day: 'numeric', month: 'long' },
  );
}

function timeLabel(iso: string, language: Language): string {
  return new Date(iso).toLocaleTimeString(
    language === 'ru' ? 'ru-RU' : 'en-GB',
    { hour: '2-digit', minute: '2-digit' },
  );
}

export function durationLabel(minutes: number, language: Language): string {
  if (minutes < 60) return language === 'ru' ? `${minutes} мин` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursPart = language === 'ru' ? `${hours} ч` : `${hours} h`;
  if (rest === 0) return hoursPart;
  return language === 'ru' ? `${hoursPart} ${rest} мин` : `${hoursPart} ${rest} min`;
}

const COPY = {
  en: {
    type: 'Appointment type',
    duration: 'Duration in minutes',
    durationShortcuts: 'Common durations',
    from: 'Search from',
    days: 'How many days',
    oneSession: 'One session',
    twoDays: 'Two days in a row',
    threeDays: 'Three days in a row',
    windowNote: 'Searching this artist\u2019s hours: {from} to {to}.',
    overridesApplied: '{count} day(s) in range have their own hours.',
    preferredStart: 'usual start',
    project: 'Project',
    enquiry: 'Enquiry',
    optional: 'optional',
    noProject: 'No project',
    noEnquiry: 'No enquiry',
    projectRequired: 'A tattoo session belongs to a project. Choose which one.',
    search: 'Find free times',
    searching: 'Looking…',
    searchFailed: 'Could not check the schedule.',
    chooseArtist: 'Choose an artist first.',
    noSlots: 'Nothing that long is free',
    noSlotsHint: 'Try a shorter session, a wider hours window, or a later start date.',
    noSeries: 'No run of days that long is free',
    noSeriesHint: 'Try two days instead of three, a shorter session, or a later start date.',
    seriesHint: '{count} days in a row',
    roomFree: '{room} free here',
    exactFit: 'exact fit',
    summary: 'Booking summary',
    summaryLine: '{type} for {client}, {date}, {duration}.',
    confirm: 'Book it',
    booking: 'Booking…',
    chooseAnother: 'Choose another time',
    bookFailed: 'Could not book that appointment.',
    staleSlot: 'The schedule changed while you were deciding. Search again to see what is free now.',
    showManual: 'Enter a time myself',
    hideManual: 'Hide manual entry',
    manualHint: 'For a time the client has already named, or one outside the hours above.',
    start: 'Start',
    end: 'End',
    bookManual: 'Book this exact time',
    manualInvalid: 'Give a start and a later end.',
    booked: 'Booked. It is proposed until the client confirms it.',
    checkTime: 'Check this time',
    checking: 'Checking the schedule\u2026',
    wouldClash: 'This clashes with {count} booking(s) and will be refused.',
    alsoThen: '{count} other appointment(s) happen then. They do not block this one.',
    types: {
      tattoo_session: 'Tattoo session',
      in_person_consultation: 'In-person consultation',
      video_consultation: 'Video consultation',
      touch_up: 'Touch-up',
    },
  },
  ru: {
    type: 'Тип записи',
    duration: 'Длительность в минутах',
    durationShortcuts: 'Частые длительности',
    from: 'Искать с',
    days: 'Сколько дней',
    oneSession: 'Один сеанс',
    twoDays: 'Два дня подряд',
    threeDays: 'Три дня подряд',
    windowNote: 'Ищем в часах мастера: с {from} до {to}.',
    overridesApplied: 'У {count} дн. в этом диапазоне свои часы.',
    preferredStart: 'обычное начало',
    project: 'Проект',
    enquiry: 'Заявка',
    optional: 'необязательно',
    noProject: 'Без проекта',
    noEnquiry: 'Без заявки',
    projectRequired: 'Тату-сеанс относится к проекту. Выберите, к какому.',
    search: 'Найти свободное время',
    searching: 'Ищем…',
    searchFailed: 'Не удалось проверить расписание.',
    chooseArtist: 'Сначала выберите мастера.',
    noSlots: 'Столько свободного времени нет',
    noSlotsHint: 'Попробуйте более короткий сеанс, более широкое окно часов или более позднюю дату.',
    noSeries: 'Столько дней подряд не свободно',
    noSeriesHint: 'Попробуйте два дня вместо трёх, более короткий сеанс или более позднюю дату.',
    seriesHint: '{count} дня подряд',
    roomFree: 'здесь свободно {room}',
    exactFit: 'впритык',
    summary: 'Итог записи',
    summaryLine: '{type} для {client}, {date}, {duration}.',
    confirm: 'Записать',
    booking: 'Записываем…',
    chooseAnother: 'Выбрать другое время',
    bookFailed: 'Не удалось создать запись.',
    staleSlot: 'Расписание изменилось, пока вы выбирали. Найдите свободное время заново.',
    showManual: 'Ввести время вручную',
    hideManual: 'Скрыть ручной ввод',
    manualHint: 'Для времени, которое клиент уже назвал, или вне указанных часов.',
    start: 'Начало',
    end: 'Конец',
    bookManual: 'Записать на это время',
    manualInvalid: 'Укажите начало и более позднее окончание.',
    booked: 'Записано. Запись предварительная, пока клиент не подтвердит.',
    checkTime: 'Проверить это время',
    checking: 'Проверяем расписание\u2026',
    wouldClash: 'Пересекается с {count} записью(ями) — такая запись будет отклонена.',
    alsoThen: 'В это же время есть ещё {count} запись(и). Они не мешают.',
    types: {
      tattoo_session: 'Тату-сеанс',
      in_person_consultation: 'Очная консультация',
      video_consultation: 'Видеоконсультация',
      touch_up: 'Коррекция',
    },
  },
} as const;
