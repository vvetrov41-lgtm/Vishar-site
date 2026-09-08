export interface ManualDateTimeParts {
  date: string;
  hour: string;
  minute: string;
}

export const MANUAL_HOUR_OPTIONS = Array.from(
  { length: 24 },
  (_, hour) => String(hour).padStart(2, '0'),
);

export const MANUAL_MINUTE_OPTIONS = Array.from(
  { length: 12 },
  (_, index) => String(index * 5).padStart(2, '0'),
);

/**
 * Split the CRM's local datetime value into deterministic picker parts.
 * Minute values are normalised forward to the next five-minute boundary so
 * an old/browser-supplied value such as 15:08 can never survive in the manual
 * booking control.
 */
export function splitManualDateTime(
  value: string,
  fallbackDate: string,
): ManualDateTimeParts {
  const [rawDate = '', rawTime = ''] = value.split('T');
  const [rawHour = '09', rawMinute = '00'] = rawTime.split(':');
  const hourNumber = Number(rawHour);
  const minuteNumber = Number(rawMinute);
  const safeHour = Number.isInteger(hourNumber) && hourNumber >= 0 && hourNumber <= 23
    ? hourNumber
    : 9;
  const safeMinute = Number.isInteger(minuteNumber) && minuteNumber >= 0 && minuteNumber <= 59
    ? minuteNumber
    : 0;

  const roundedMinute = Math.ceil(safeMinute / 5) * 5;
  const rollsHour = roundedMinute === 60;
  const nextHour = rollsHour ? (safeHour + 1) % 24 : safeHour;
  const date = rawDate || fallbackDate;

  if (!rollsHour || safeHour < 23 || !date) {
    return {
      date,
      hour: String(nextHour).padStart(2, '0'),
      minute: String(rollsHour ? 0 : roundedMinute).padStart(2, '0'),
    };
  }

  const nextDate = new Date(`${date}T00:00:00`);
  if (!Number.isNaN(nextDate.getTime())) {
    nextDate.setDate(nextDate.getDate() + 1);
    const month = String(nextDate.getMonth() + 1).padStart(2, '0');
    const day = String(nextDate.getDate()).padStart(2, '0');
    return {
      date: `${nextDate.getFullYear()}-${month}-${day}`,
      hour: '00',
      minute: '00',
    };
  }

  return { date, hour: '00', minute: '00' };
}

export function composeManualDateTime(parts: ManualDateTimeParts): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts.date)) return '';
  if (!MANUAL_HOUR_OPTIONS.includes(parts.hour)) return '';
  if (!MANUAL_MINUTE_OPTIONS.includes(parts.minute)) return '';
  return `${parts.date}T${parts.hour}:${parts.minute}`;
}
