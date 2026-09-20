// The week and day grid, and the interaction surface for moving an
// appointment or changing its duration.
//
// Both gestures have equivalent pointer and keyboard/touch paths. Moving a
// block exposes slot targets for its new start; activating the lower resize
// handle exposes valid end-time targets. Those accessible target paths are
// first-class interactions rather than test-only fallbacks.
//
// Nothing here decides whether a move or resize is allowed. The page asks the
// server and restores the authoritative window when the server says no.

import { useState, type CSSProperties } from 'react';
import type { Language } from '../lib/i18n';
import type { Client, Project } from '../lib/types';
import type { Appointment } from '../lib/appointment-api';
import {
  SLOT_MINUTES,
  addZonedDays,
  resizeTarget,
  slotLabel,
  slotsFor,
  startOfZonedDay,
  zonedParts,
  zonedTimeLabel,
  type WeekCalendar,
  type WeekCalendarDay,
  type WeekEntry,
} from '../lib/calendar-week';
import { timeOffLabel } from './MonthCalendarView';
import { typeLabel } from './AppointmentRow';

export interface WeekMoveRequest {
  appointment: Appointment;
  dayStart: number;
  minutesFromMidnight: number;
}

export interface WeekResizeRequest {
  appointment: Appointment;
  endDayStart: number;
  endMinutesFromMidnight: number;
}

export function WeekCalendarView({
  calendar,
  language,
  clients,
  projects,
  artistNames,
  statusLabelFor,
  canMove,
  movingAppointmentId,
  onMove,
  onResize,
  onPrevious,
  onNext,
  onToday,
  heading,
}: {
  calendar: WeekCalendar;
  language: Language;
  clients: Client[];
  projects: Project[];
  artistNames: Record<string, string>;
  statusLabelFor: (appointment: Appointment) => string;
  canMove: (appointment: Appointment) => boolean;
  movingAppointmentId: string | null;
  onMove: (request: WeekMoveRequest) => void;
  onResize: (request: WeekResizeRequest) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  heading: string;
}) {
  const copy = COPY[language];
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resizePickingId, setResizePickingId] = useState<string | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const slots = slotsFor(calendar);
  const picking = pickingId
    ? calendar.days
      .flatMap((day) => day.entries)
      .find((entry) => entry.kind === 'appointment' && entry.appointment.id === pickingId)
    : undefined;
  const resizePicking = resizePickingId
    ? calendar.days
      .flatMap((day) => day.entries)
      .find((entry) => entry.kind === 'appointment' && entry.appointment.id === resizePickingId)
    : undefined;

  function complete(appointment: Appointment, day: WeekCalendarDay, minutes: number) {
    setPickingId(null);
    setResizePickingId(null);
    setDraggingId(null);
    setResizingId(null);
    onMove({ appointment, dayStart: day.date, minutesFromMidnight: minutes });
  }

  function completeResize(appointment: Appointment, day: WeekCalendarDay, slotStart: number) {
    setPickingId(null);
    setResizePickingId(null);
    setDraggingId(null);
    setResizingId(null);
    onResize({
      appointment,
      endDayStart: day.date,
      endMinutesFromMidnight: slotStart + SLOT_MINUTES,
    });
  }

  function appointmentFor(id: string): Appointment | null {
    for (const day of calendar.days) {
      for (const entry of day.entries) {
        if (entry.kind === 'appointment' && entry.appointment.id === id) return entry.appointment;
      }
    }
    return null;
  }

  function canResizeTo(appointment: Appointment, day: WeekCalendarDay, slotStart: number): boolean {
    if (!appointmentFitsSingleDay(appointment, day.date, calendar.timeZone)) return false;
    return resizeTarget({
      appointment,
      endDayStart: day.date,
      endMinutesFromMidnight: slotStart + SLOT_MINUTES,
      timeZone: calendar.timeZone,
    }) !== null;
  }

  return (
    <>
      <div className="calendar-toolbar">
        <h3>{heading}</h3>
        <div className="calendar-toolbar-actions">
          <button type="button" aria-label={copy.previous} onClick={onPrevious}>‹</button>
          <button type="button" onClick={onToday}>{copy.today}</button>
          <button type="button" aria-label={copy.next} onClick={onNext}>›</button>
        </div>
      </div>

      {picking && picking.kind === 'appointment' ? (
        <p className="notice" role="status">
          {copy.pickSlot.replace('{name}', describe(picking.appointment, clients, language))}{' '}
          <button type="button" onClick={() => setPickingId(null)}>{copy.cancelMove}</button>
        </p>
      ) : null}
      {resizePicking && resizePicking.kind === 'appointment' ? (
        <p className="notice" role="status">
          {copy.pickEnd.replace('{name}', describe(resizePicking.appointment, clients, language))}{' '}
          <button type="button" onClick={() => setResizePickingId(null)}>{copy.cancelResize}</button>
        </p>
      ) : null}

      <div
        className="week-grid"
        role="group"
        aria-label={heading}
        style={{ '--week-days': calendar.days.length } as CSSProperties}
      >
        <div className="week-gutter" aria-hidden="true">
          <div className="week-gutter-head" />
          {slots.map((minutes) => (
            <div key={minutes} className="week-gutter-slot">
              {minutes % 60 === 0 ? slotLabel(minutes) : ''}
            </div>
          ))}
        </div>

        {calendar.days.map((day) => (
          <div key={day.date} className={`week-day${day.isToday ? ' today' : ''}`}>
            <div className="week-day-head">{dayColumnHeading(day.date, calendar.timeZone, language)}</div>
            {day.entries.filter((entry) => entry.kind === 'time_off' && entry.allDay).map((entry) => (
              <div key={entry.key} className="week-all-day">
                {entry.kind === 'time_off' ? timeOffLabel(entry.block.block_kind, language) : null}
              </div>
            ))}
            {/* Two layers, not one. The slots are the grid and the drop
                targets, and they keep their exact row height whatever is
                booked - otherwise a six-hour block would stretch its own slot
                and every hour label below it would stop lining up. The events
                float above, positioned by time. */}
            <div className="week-day-body">
              <div className="week-slots">
                {slots.map((minutes) => {
                  const pointerResize = resizingId ? appointmentFor(resizingId) : null;
                  const selectedResize = resizePicking && resizePicking.kind === 'appointment'
                    ? resizePicking.appointment
                    : null;
                  const resizeAppointment = pointerResize ?? selectedResize;
                  const resizeAllowed = resizeAppointment
                    ? canResizeTo(resizeAppointment, day, minutes)
                    : false;

                  return (
                    <div
                      key={minutes}
                      className={`week-slot${resizingId && resizeAllowed ? ' resize-target' : ''}`}
                      onDragOver={(event) => {
                        if (resizingId) {
                          if (resizeAllowed) event.preventDefault();
                          return;
                        }
                        if (!draggingId) return;
                        event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const raw = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
                        const resizeId = resizingId ?? (raw.startsWith('resize:') ? raw.slice(7) : '');
                        if (resizeId) {
                          const appointment = appointmentFor(resizeId);
                          if (!appointment || !canMove(appointment) || !canResizeTo(appointment, day, minutes)) {
                            setResizingId(null);
                            return;
                          }
                          completeResize(appointment, day, minutes);
                          return;
                        }

                        const id = draggingId ?? (raw.startsWith('move:') ? raw.slice(5) : raw);
                        if (!id) return;
                        const appointment = appointmentFor(id);
                        if (!appointment || !canMove(appointment)) return;
                        complete(appointment, day, minutes);
                      }}
                    >
                      {resizePicking && resizePicking.kind === 'appointment' && resizeAllowed ? (
                        <button
                          type="button"
                          className="week-slot-target resize-target-button"
                          aria-label={copy.resizeHere
                            .replace('{day}', dayColumnHeading(day.date, calendar.timeZone, language))
                            .replace('{time}', boundaryLabel(minutes + SLOT_MINUTES))}
                          onClick={() => completeResize(resizePicking.appointment, day, minutes)}
                        >
                          {boundaryLabel(minutes + SLOT_MINUTES)}
                        </button>
                      ) : picking && picking.kind === 'appointment' ? (
                        <button
                          type="button"
                          className="week-slot-target"
                          aria-label={copy.moveHere
                            .replace('{day}', dayColumnHeading(day.date, calendar.timeZone, language))
                            .replace('{time}', slotLabel(minutes))}
                          onClick={() => complete(picking.appointment, day, minutes)}
                        >
                          {slotLabel(minutes)}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {/* While something is being dragged the whole layer stops taking
                  pointer events, so the drop lands on the slot underneath
                  rather than on whatever block happens to cover it. */}
              <div className={`week-day-events${draggingId ? ' dragging' : ''}${resizingId ? ' resizing' : ''}`}>
                {day.entries
                  .filter((entry) => !(entry.kind === 'time_off' && entry.allDay))
                  .map((entry) => ({ entry, placement: placeEntry(entry, calendar) }))
                  .filter((placed) => placed.placement !== null)
                  .map(({ entry, placement }) => (
                    <EntryBlock
                      key={entry.key}
                      entry={entry}
                      placement={placement!}
                      language={language}
                      clients={clients}
                      projects={projects}
                      artistNames={artistNames}
                      statusLabelFor={statusLabelFor}
                      canMove={canMove}
                      busy={
                        entry.kind === 'appointment'
                        && movingAppointmentId === entry.appointment.id
                      }
                      picking={
                        entry.kind === 'appointment' && pickingId === entry.appointment.id
                      }
                      resizePicking={
                        entry.kind === 'appointment' && resizePickingId === entry.appointment.id
                      }
                      resizing={
                        entry.kind === 'appointment' && resizingId === entry.appointment.id
                      }
                      resizeEnabled={
                        entry.kind === 'appointment'
                        && canMove(entry.appointment)
                        && appointmentFitsSingleDay(entry.appointment, day.date, calendar.timeZone)
                      }
                      timeZone={calendar.timeZone}
                      onStartPick={(appointment) => {
                        setResizePickingId(null);
                        setPickingId(pickingId === appointment.id ? null : appointment.id);
                      }}
                      onDragStart={(appointment, dataTransfer) => {
                        setResizePickingId(null);
                        setDraggingId(appointment.id);
                        try { dataTransfer?.setData('text/plain', `move:${appointment.id}`); } catch { /* jsdom */ }
                      }}
                      onDragEnd={() => setDraggingId(null)}
                      onStartResizePick={(appointment) => {
                        setPickingId(null);
                        setResizePickingId(resizePickingId === appointment.id ? null : appointment.id);
                      }}
                      onResizeDragStart={(appointment, dataTransfer) => {
                        setPickingId(null);
                        setResizePickingId(null);
                        setResizingId(appointment.id);
                        try { dataTransfer?.setData('text/plain', `resize:${appointment.id}`); } catch { /* jsdom */ }
                      }}
                      onResizeDragEnd={() => setResizingId(null)}
                    />
                  ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Where a block sits in its column, in slot units counted from the first hour
 * line. An entry that starts before the grid or runs past its end is clipped to
 * what is visible rather than dropped, so a block that began yesterday still
 * shows against the hours it covers today.
 */
function placeEntry(
  entry: WeekEntry,
  calendar: WeekCalendar
): { offsetSlots: number; spanSlots: number } | null {
  const gridStart = calendar.startHour * 60;
  const gridEnd = calendar.endHour * 60;
  const from = Math.max(entry.startMinutes, gridStart);
  const to = Math.min(Math.max(entry.endMinutes, entry.startMinutes + 15), gridEnd);
  if (to <= from) return null;
  return {
    offsetSlots: (from - gridStart) / SLOT_MINUTES,
    spanSlots: (to - from) / SLOT_MINUTES,
  };
}

function EntryBlock({
  entry,
  placement,
  language,
  clients,
  projects,
  artistNames,
  statusLabelFor,
  canMove,
  busy,
  picking,
  resizePicking,
  resizing,
  resizeEnabled,
  timeZone,
  onStartPick,
  onDragStart,
  onDragEnd,
  onStartResizePick,
  onResizeDragStart,
  onResizeDragEnd,
}: {
  entry: WeekEntry;
  placement: { offsetSlots: number; spanSlots: number };
  language: Language;
  clients: Client[];
  projects: Project[];
  artistNames: Record<string, string>;
  statusLabelFor: (appointment: Appointment) => string;
  canMove: (appointment: Appointment) => boolean;
  busy: boolean;
  picking: boolean;
  resizePicking: boolean;
  resizing: boolean;
  resizeEnabled: boolean;
  timeZone: string;
  onStartPick: (appointment: Appointment) => void;
  onDragStart: (appointment: Appointment, dataTransfer: DataTransfer | null) => void;
  onDragEnd: () => void;
  onStartResizePick: (appointment: Appointment) => void;
  onResizeDragStart: (appointment: Appointment, dataTransfer: DataTransfer | null) => void;
  onResizeDragEnd: () => void;
}) {
  const copy = COPY[language];
  const style = {
    top: `calc(${placement.offsetSlots} * var(--week-slot-height))`,
    height: `calc(${placement.spanSlots} * var(--week-slot-height))`,
  };

  if (entry.kind === 'time_off') {
    return (
      <div className="week-event time-off" style={style}>
        <span className="week-event-time">{slotLabel(entry.startMinutes)}</span>
        <span className="week-event-title">{timeOffLabel(entry.block.block_kind, language)}</span>
      </div>
    );
  }

  const appointment = entry.appointment;
  const movable = canMove(appointment);
  const client = clients.find((row) => row.id === appointment.client_id) ?? null;
  const project = projects.find((row) => row.id === appointment.project_id) ?? null;
  const artistName = artistNames[appointment.artist_id];

  return (
    <div
      className={`week-event status-${appointment.status}${busy ? ' busy' : ''}${picking ? ' picking' : ''}${resizePicking ? ' resize-picking' : ''}${resizing ? ' resizing' : ''}${resizeEnabled ? ' resizable' : ''}`}
      style={style}
      draggable={movable && !busy && !resizing}
      data-appointment-id={appointment.id}
      onDragStart={(event) => {
        if ((event.target as HTMLElement).closest('.week-event-resize')) {
          event.preventDefault();
          return;
        }
        onDragStart(appointment, event.dataTransfer ?? null);
      }}
      onDragEnd={onDragEnd}
    >
      <span className="week-event-time">
        {zonedTimeLabel(appointment.start_at, timeZone)}–{zonedTimeLabel(appointment.end_at, timeZone)}
      </span>
      <span className="week-event-title">{client?.full_name ?? copy.noClient}</span>
      <span className="week-event-meta">{typeLabel(appointment.appointment_type, language)}</span>
      {project ? <span className="week-event-meta">{project.title}</span> : null}
      {artistName ? <span className="week-event-meta">{artistName}</span> : null}
      <span className="week-event-meta">{statusLabelFor(appointment)}</span>
      {movable ? (
        <button
          type="button"
          className="week-event-move"
          disabled={busy}
          aria-pressed={picking}
          aria-label={`${copy.move}: ${describe(appointment, clients, language)}`}
          onClick={() => onStartPick(appointment)}
        >
          {busy ? copy.saving : copy.move}
        </button>
      ) : null}
      {resizeEnabled ? (
        <button
          type="button"
          className="week-event-resize"
          draggable={!busy}
          disabled={busy}
          aria-pressed={resizePicking}
          aria-label={`${copy.resize}: ${describe(appointment, clients, language)}`}
          onClick={(event) => {
            event.stopPropagation();
            onStartResizePick(appointment);
          }}
          onDragStart={(event) => {
            event.stopPropagation();
            onResizeDragStart(appointment, event.dataTransfer ?? null);
          }}
          onDragEnd={(event) => {
            event.stopPropagation();
            onResizeDragEnd();
          }}
        >
          <span aria-hidden="true">↕</span>
        </button>
      ) : null}
    </div>
  );
}

function appointmentFitsSingleDay(
  appointment: Appointment,
  dayStart: number,
  timeZone: string
): boolean {
  const start = Date.parse(appointment.start_at);
  const end = Date.parse(appointment.end_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const dayEnd = startOfZonedDay(addZonedDays(dayStart, 1, timeZone), timeZone);
  return start >= dayStart && start < dayEnd && end <= dayEnd;
}

function boundaryLabel(minutes: number): string {
  return minutes === 24 * 60 ? '24:00' : slotLabel(minutes);
}

function describe(appointment: Appointment, clients: Client[], language: Language): string {
  const client = clients.find((row) => row.id === appointment.client_id);
  const who = client?.full_name ?? COPY[language].noClient;
  return `${typeLabel(appointment.appointment_type, language)} · ${who}`;
}

const DAY_COLUMN: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
  ru: new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }),
};

export function dayColumnHeading(date: number, timeZone: string, language: Language): string {
  // The label names the artist's day, so it is formatted from that day's own
  // wall clock rather than from whatever the operator's browser thinks.
  const parts = zonedParts(date, timeZone);
  return DAY_COLUMN[language].format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
}

export function weekHeading(calendar: WeekCalendar, language: Language): string {
  const first = zonedParts(calendar.days[0].date, calendar.timeZone);
  const last = zonedParts(calendar.days[calendar.days.length - 1].date, calendar.timeZone);
  const formatter = new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const from = formatter.format(new Date(Date.UTC(first.year, first.month - 1, first.day, 12)));
  if (calendar.days.length === 1) return from;
  const to = formatter.format(new Date(Date.UTC(last.year, last.month - 1, last.day, 12)));
  return `${from} – ${to}`;
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    previous: 'Previous',
    next: 'Next',
    today: 'Today',
    move: 'Move',
    moveHere: 'Move to {day} at {time}',
    pickSlot: 'Choose a new time for {name}.',
    cancelMove: 'Cancel',
    resize: 'Change duration',
    resizeHere: 'Set end on {day} at {time}',
    pickEnd: 'Choose a new end time for {name}.',
    cancelResize: 'Cancel',
    saving: 'Saving…',
    noClient: 'No client',
  },
  ru: {
    previous: 'Назад',
    next: 'Вперёд',
    today: 'Сегодня',
    move: 'Перенести',
    moveHere: 'Перенести на {day}, {time}',
    pickSlot: 'Выберите новое время для «{name}».',
    cancelMove: 'Отмена',
    resize: 'Изменить длительность',
    resizeHere: 'Закончить {day} в {time}',
    pickEnd: 'Выберите новое время окончания для «{name}».',
    cancelResize: 'Отмена',
    saving: 'Сохраняем…',
    noClient: 'Без клиента',
  },
};
