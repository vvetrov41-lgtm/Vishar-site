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
//   - the hours window is a visible, editable field, because this schema has
//     no working-hours table. Rather than hard-code a studio day, the panel
//     shows the assumption it is making and lets the operator change it.
//   - manual entry stays. Smart search answers "when could I fit this?", and
//     that is most bookings but not all: rescheduling to a time the client
//     already named, or booking outside the usual hours, is still typing two
//     datetimes, and removing that would be a downgrade.

import { useMemo, useState, type FormEvent } from 'react';
import { EmptyState } from './StateViews';
import { findAvailableSlots, findConsecutiveDaySlots, type Slot } from '../lib/availability';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { AppointmentType } from '../lib/appointment-api';

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

export interface BookingPanelProps {
  artistId: string | null;
  clientId: string;
  clientName: string;
  enquiryId?: string | null;
  projectId?: string | null;
  /** Types the calling screen allows. Projects require a project-linked type. */
  onBooked: (appointmentId: string | null) => void;
}

type Stage = 'search' | 'chosen';

export function BookingPanel({
  artistId,
  clientId,
  clientName,
  enquiryId = null,
  projectId = null,
  onBooked,
}: BookingPanelProps) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];

  const [appointmentType, setAppointmentType] = useState<AppointmentType>('tattoo_session');
  const [durationMinutes, setDurationMinutes] = useState(420);
  const [earliestHour, setEarliestHour] = useState(10);
  const [latestHour, setLatestHour] = useState(20);
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
  const [manual, setManual] = useState(false);
  const [manualStart, setManualStart] = useState('');
  const [manualEnd, setManualEnd] = useState('');

  const durations = DURATION_MINUTES[appointmentType];
  const hoursValid = latestHour > earliestHour;

  const grouped = useMemo(() => groupByDay(slots ?? []), [slots]);

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setWarning(null);
    setChosen(null);
    setSeries(null);
    setStage('search');
    if (!artistId) {
      setError(copy.chooseArtist);
      return;
    }
    if (!hoursValid) {
      setError(copy.hoursInvalid);
      return;
    }

    setSearching(true);
    try {
      const from = new Date(`${fromDate}T00:00:00`);
      const to = new Date(from);
      to.setDate(to.getDate() + SEARCH_DAYS);

      // Both reads are authoritative and server-side: listAppointments is
      // RLS-filtered, and list_artist_availability_blocks is SECURITY DEFINER
      // behind require_artist_access. Nothing about "free" is decided from
      // anything the browser made up.
      const [appointments, timeOff] = await Promise.all([
        api.listAppointments({ artistId }),
        api.listAvailabilityBlocks({
          artistId,
          from: from.toISOString(),
          to: to.toISOString(),
        }),
      ]);

      const search = {
        now: new Date(),
        from,
        to,
        durationMinutes,
        dayWindow: { earliestHour, latestHour },
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

  async function book(startAt: string, endAt: string) {
    if (!artistId) {
      setError(copy.chooseArtist);
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
        enquiryId,
        projectId,
      });
      const appointmentId = typeof result?.appointment_id === 'string' ? result.appointment_id : null;
      onBooked(appointmentId);
      setStage('search');
      setChosen(null);
      setSlots(null);
      setSeries(null);
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

        {/* Stated, not assumed. This schema has no working hours, so the panel
            shows the window it is searching and lets the operator widen it. */}
        <fieldset className="booking-hours">
          <legend>{copy.between}</legend>
          <div className="form-grid">
            <label>
              <span>{copy.earliest}</span>
              <input
                type="number"
                min={0}
                max={23}
                value={earliestHour}
                onChange={(event) => setEarliestHour(clampHour(event.target.value, 0, 23))}
              />
            </label>
            <label>
              <span>{copy.latest}</span>
              <input
                type="number"
                min={1}
                max={24}
                value={latestHour}
                onChange={(event) => setLatestHour(clampHour(event.target.value, 1, 24))}
              />
            </label>
          </div>
          <p className="meta">{copy.hoursHint}</p>
        </fieldset>

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
          <div className="actions">
            <button
              type="button"
              disabled={booking || !manualStart || !manualEnd}
              onClick={() => {
                const start = new Date(manualStart);
                const end = new Date(manualEnd);
                if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
                  setError(copy.manualInvalid);
                  return;
                }
                void book(start.toISOString(), end.toISOString());
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

function clampHour(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
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
    between: 'Between these hours',
    earliest: 'Not before',
    latest: 'Finished by',
    hoursHint: 'The CRM holds no studio opening hours, so this is the window being searched. Widen it to see every free gap.',
    hoursInvalid: 'The finish hour has to be later than the start hour.',
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
    between: 'В эти часы',
    earliest: 'Не раньше',
    latest: 'Закончить до',
    hoursHint: 'В CRM нет часов работы студии, поэтому поиск идёт в этом окне. Расширьте его, чтобы увидеть все свободные промежутки.',
    hoursInvalid: 'Час окончания должен быть позже часа начала.',
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
    types: {
      tattoo_session: 'Тату-сеанс',
      in_person_consultation: 'Очная консультация',
      video_consultation: 'Видеоконсультация',
      touch_up: 'Коррекция',
    },
  },
} as const;
