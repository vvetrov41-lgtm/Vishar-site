export const APPOINTMENT_TIME_STEP_SECONDS = 300;
export const APPOINTMENT_TIME_STEP_MINUTES = APPOINTMENT_TIME_STEP_SECONDS / 60;

export function applyAppointmentTimeStep(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>(
    'input[type="datetime-local"]:not([data-appointment-time-step="unrestricted"])',
  ).forEach((input) => {
    input.step = String(APPOINTMENT_TIME_STEP_SECONDS);
  });
}

export function toLocalDateTimeValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Snap an automatically suggested start forward to the next legal five-minute
 * boundary. Moving forward avoids opening manual entry with a time already in
 * the past while also guaranteeing the browser will accept the value.
 */
export function snapAppointmentStart(date: Date): string {
  const snapped = new Date(date);
  snapped.setSeconds(0, 0);
  const remainder = snapped.getMinutes() % APPOINTMENT_TIME_STEP_MINUTES;
  if (remainder !== 0) {
    snapped.setMinutes(snapped.getMinutes() + (APPOINTMENT_TIME_STEP_MINUTES - remainder));
  }
  return toLocalDateTimeValue(snapped);
}

/** The selected duration is authoritative; manual end time is derived from it. */
export function appointmentEndValue(startValue: string, durationMinutes: number): string {
  if (!startValue || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return '';
  const start = new Date(startValue);
  if (Number.isNaN(start.getTime())) return '';
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return toLocalDateTimeValue(end);
}

export function appointmentTimeRange(
  startValue: string,
  durationMinutes: number,
): { start: string; end: string } | null {
  const endValue = appointmentEndValue(startValue, durationMinutes);
  if (!endValue) return null;
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}
