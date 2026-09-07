// What the database actually refused, said in the operator's language.
//
// Every booking failure used to arrive as one sentence: "The schedule changed
// while you were deciding. Search again to see what is free now." It was
// right roughly never. The common case in production was an enquiry with no
// project - `sessions_project_required_for_work` refusing a tattoo session -
// and the operator was sent back to re-search a slot that was never taken.
//
// The database now names its refusals. Migration
// 20260907070000_enquiry_auto_project_booking raises every deliberate booking
// refusal through `crm_private.booking_error`, which puts a stable code in the
// exception HINT and leaves SQLSTATE and message as they were. This module is
// the other half of that contract: the code decides the sentence, and an
// unrecognised failure gets the honest generic one rather than a guess.
//
// Calendar failures are deliberately absent. A booking never waits for Google:
// the calendar job is queued in the same transaction and drained afterwards,
// so what the calendar did is a property of the appointment row and is already
// said by `calendarSyncLabel` in calendar-sync.ts.

import type { Language } from './i18n';

export const BOOKING_ERROR_CODES = [
  'PROJECT_REQUIRED',
  'TOUCH_UP_PROJECT_REQUIRED',
  'PROJECT_NOT_FOUND',
  'PROJECT_LINK_MISMATCH',
  'ENQUIRY_NOT_FOUND',
  'ENQUIRY_LINK_MISMATCH',
  'ENQUIRY_INTAKE_INCOMPLETE',
  'ENQUIRY_NOT_BOOKABLE',
  'CLIENT_NOT_FOUND',
  'SLOT_NO_LONGER_AVAILABLE',
  'ARTIST_UNAVAILABLE',
  'CONSULTATION_DURING_TATTOO_BLOCKED',
  'INVALID_APPOINTMENT_TYPE',
  'INVALID_APPOINTMENT_STATUS',
  'INVALID_APPOINTMENT_WINDOW',
  'PERMISSION_DENIED',
] as const;

export type BookingErrorCode = (typeof BOOKING_ERROR_CODES)[number];

const KNOWN = new Set<string>(BOOKING_ERROR_CODES);

/**
 * The code the database attached to this refusal, or null when the failure is
 * not one the booking path names - a dropped connection, say, where the honest
 * answer is that nobody knows.
 *
 * A permission denial has carried SQLSTATE 42501 since long before the codes
 * existed and is raised from shared authorization helpers, so it is read from
 * the SQLSTATE rather than requiring every one of them to be rewritten.
 */
export function bookingErrorCode(error: unknown): BookingErrorCode | null {
  const cause = unwrapCause(error);
  if (!cause || typeof cause !== 'object') return null;

  const hint = readString(cause, 'hint');
  if (KNOWN.has(hint)) return hint as BookingErrorCode;

  const code = readString(cause, 'code');
  if (code === '42501' || code === 'PGRST301') return 'PERMISSION_DENIED';

  return null;
}

/**
 * True only when the slot genuinely went. This is the one case where telling
 * the operator to search again is useful advice rather than a wild goose
 * chase, so it gates that message everywhere.
 */
export function isSlotConflict(code: BookingErrorCode | null): boolean {
  return code === 'SLOT_NO_LONGER_AVAILABLE'
    || code === 'ARTIST_UNAVAILABLE'
    || code === 'CONSULTATION_DURING_TATTOO_BLOCKED';
}

export function bookingErrorMessage(code: BookingErrorCode, language: Language): string {
  return MESSAGES[language][code];
}

function unwrapCause(error: unknown): unknown {
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') return cause;
  }
  return error;
}

function readString(value: object, key: string): string {
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : '';
}

const MESSAGES: Record<Language, Record<BookingErrorCode, string>> = {
  en: {
    PROJECT_REQUIRED:
      'Tattoo work belongs to a project. Book from the enquiry, or choose the project this session is part of.',
    TOUCH_UP_PROJECT_REQUIRED:
      'A touch-up belongs to the project of the tattoo being touched up. Open that project and book it there.',
    PROJECT_NOT_FOUND: 'That project no longer exists. Reload and try again.',
    PROJECT_LINK_MISMATCH:
      'That project belongs to a different client, artist or enquiry. Nothing was booked.',
    ENQUIRY_NOT_FOUND: 'That enquiry no longer exists. Reload and try again.',
    ENQUIRY_LINK_MISMATCH:
      'This enquiry belongs to a different client or artist. Nothing was booked.',
    ENQUIRY_INTAKE_INCOMPLETE:
      'This enquiry is still incomplete, so it cannot start tattoo work yet. Finish the intake first.',
    ENQUIRY_NOT_BOOKABLE:
      'This enquiry is declined or closed. Reopen it before booking tattoo work.',
    CLIENT_NOT_FOUND: 'That client no longer exists. Reload and try again.',
    SLOT_NO_LONGER_AVAILABLE:
      'The schedule changed while you were deciding. Search again to see what is free now.',
    ARTIST_UNAVAILABLE: 'That time is blocked in artist availability.',
    CONSULTATION_DURING_TATTOO_BLOCKED:
      'This artist does not take consultations during a tattoo session.',
    INVALID_APPOINTMENT_TYPE: 'Choose what kind of appointment this is.',
    INVALID_APPOINTMENT_STATUS: 'A new appointment cannot start in that state.',
    INVALID_APPOINTMENT_WINDOW: 'Give a start and a later end.',
    PERMISSION_DENIED:
      'You do not have permission to book this. Nothing was saved — ask the studio owner for access.',
  },
  ru: {
    PROJECT_REQUIRED:
      'Тату-работа относится к проекту. Записывайте из заявки или выберите проект, к которому относится сеанс.',
    TOUCH_UP_PROJECT_REQUIRED:
      'Коррекция относится к проекту той же тату. Откройте этот проект и запишите коррекцию там.',
    PROJECT_NOT_FOUND: 'Такого проекта больше нет. Обновите страницу и попробуйте снова.',
    PROJECT_LINK_MISMATCH:
      'Этот проект принадлежит другому клиенту, мастеру или заявке. Запись не создана.',
    ENQUIRY_NOT_FOUND: 'Такой заявки больше нет. Обновите страницу и попробуйте снова.',
    ENQUIRY_LINK_MISMATCH:
      'Эта заявка принадлежит другому клиенту или мастеру. Запись не создана.',
    ENQUIRY_INTAKE_INCOMPLETE:
      'Заявка ещё не заполнена, поэтому начать работу нельзя. Сначала завершите анкету.',
    ENQUIRY_NOT_BOOKABLE:
      'Заявка отклонена или закрыта. Верните её в работу, прежде чем записывать тату-сеанс.',
    CLIENT_NOT_FOUND: 'Такого клиента больше нет. Обновите страницу и попробуйте снова.',
    SLOT_NO_LONGER_AVAILABLE:
      'Расписание изменилось, пока вы выбирали. Найдите свободное время заново.',
    ARTIST_UNAVAILABLE: 'Это время закрыто в занятости мастера.',
    CONSULTATION_DURING_TATTOO_BLOCKED:
      'Этот мастер не проводит консультации во время тату-сеанса.',
    INVALID_APPOINTMENT_TYPE: 'Выберите тип записи.',
    INVALID_APPOINTMENT_STATUS: 'Новая запись не может начинаться в таком состоянии.',
    INVALID_APPOINTMENT_WINDOW: 'Укажите начало и более позднее окончание.',
    PERMISSION_DENIED:
      'Недостаточно прав, чтобы создать эту запись. Изменения не сохранены — попросите владельца студии открыть доступ.',
  },
};
