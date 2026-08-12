// Integration outbox helpers.
//
// The outbox is the reason a Telegram or email failure cannot damage a booking:
// side effects are recorded as durable jobs inside the same transaction that
// commits the enquiry, then attempted afterwards. An attempt that fails remains
// durable for the planned drain; this module does not schedule or run a drain.
//
// Dedupe keys are built in one place so a retry collides with the original job
// instead of producing a second notification or a duplicate calendar event.
// These must match `public.calendar_outbox_dedupe_key` in migration 0005.

export const OUTBOX_KINDS = Object.freeze({
  TELEGRAM_NOTIFICATION: 'telegram_notification',
  TRANSACTIONAL_EMAIL: 'transactional_email',
  APPROVED_EMAIL: 'approved_email',
  CALENDAR_CREATE: 'calendar_create',
  CALENDAR_UPDATE: 'calendar_update',
  CALENDAR_CANCEL: 'calendar_cancel',
  RECONCILIATION: 'reconciliation',
});

export function telegramDedupeKey(enquiryId) {
  return `telegram:enquiry_created:${enquiryId}`;
}

export function calendarDedupeKey(action, sessionId, version) {
  return `calendar:${action}:${sessionId}:${version}`;
}

export function emailDedupeKey(emailMessageId) {
  return `email:approved:${emailMessageId}`;
}

/** Bounded exponential backoff with a cap, matching the outbox schema. */
export function nextAttemptDelaySeconds(attemptCount) {
  const attempt = Number.isFinite(attemptCount) ? Math.max(0, Math.floor(attemptCount)) : 0;
  return Math.min(2 ** attempt * 30, 3600);
}

export function isExhausted(job) {
  return Number(job?.attempt_count) >= Number(job?.max_attempts ?? 8);
}
