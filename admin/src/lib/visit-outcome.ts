// Pure helpers for the visit outcome card. No API access here.
import type { VisitFinance } from './visit-outcome-api';

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** A GBP amount typed on a phone: "980", "980.5", "980,50". Zero allowed. */
export function parseMoneyInput(raw: string, { allowZero = false } = {}): number | null {
  const value = raw.trim().replace(',', '.');
  if (value === '') return allowZero ? 0 : null;
  if (!/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount > 100000) return null;
  if (amount === 0) return allowZero ? 0 : null;
  return amount;
}

/** Hours typed as "4", "4.5", "4,25" → whole minutes (1..1440). */
export function parseHoursInput(raw: string): number | null {
  const value = raw.trim().replace(',', '.');
  if (!/^[0-9]{1,2}(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const minutes = Math.round(Number(value) * 60);
  return minutes >= 1 && minutes <= 1440 ? minutes : null;
}

export function minutesToHoursInput(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '';
  const hours = Math.round((minutes / 60) * 100) / 100;
  return String(hours);
}

export interface PaymentPreview {
  /** Money for this session already in the ledger: deposit + earlier receipts. */
  alreadyRecorded: number;
  /** What is left before anything is recorded now. Null when unsafe to say. */
  dueBefore: number | null;
  /** What would be left after the amount typed now. */
  dueAfter: number | null;
  totalPaid: number | null;
  state: 'paid' | 'part_paid' | 'unpaid' | 'needs_review' | 'unknown';
  overBalance: boolean;
}

/**
 * The same arithmetic the database applies, shown before saving:
 * price − earlier deposit − earlier receipts − money received now.
 * The deposit is never counted as new income.
 */
export function previewPayment(
  finance: VisitFinance | null,
  price: number | null,
  receivedNow: number,
  paidOutsideCrm: boolean,
): PaymentPreview {
  if (!finance) {
    return { alreadyRecorded: 0, dueBefore: null, dueAfter: null, totalPaid: null, state: 'unknown', overBalance: false };
  }
  const alreadyRecorded = round(finance.deposit_paid + finance.invoiced_paid);
  if (finance.warnings.length > 0) {
    return { alreadyRecorded, dueBefore: null, dueAfter: null, totalPaid: null, state: 'needs_review', overBalance: false };
  }
  if (price == null) {
    return { alreadyRecorded, dueBefore: null, dueAfter: null, totalPaid: null, state: 'unknown', overBalance: false };
  }
  const dueBefore = round(Math.max(0, price - alreadyRecorded));
  const overBalance = receivedNow > dueBefore + 0.005;
  const dueAfter = paidOutsideCrm ? 0 : round(Math.max(0, dueBefore - receivedNow));
  const totalPaid = paidOutsideCrm ? price : round(alreadyRecorded + Math.min(receivedNow, dueBefore));
  const state = dueAfter === 0 ? 'paid' : totalPaid > 0 ? 'part_paid' : 'unpaid';
  return { alreadyRecorded, dueBefore, dueAfter, totalPaid, state, overBalance };
}

/** "Later" moves the card to tomorrow morning, or three hours ahead late at night. */
export function deferUntil(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(10, 0, 0, 0);
  const hours = (next.getTime() - now.getTime()) / 3_600_000;
  if (hours < 3) return new Date(now.getTime() + 3 * 3_600_000);
  return next;
}

/** A follow-up date (yyyy-mm-dd from a date input) at 10:00 local time. */
export function followUpAt(dateInput: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return null;
  const [year, month, day] = dateInput.split('-').map(Number);
  const at = new Date(year, month - 1, day, 10, 0, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function dateInputAfter(now: Date, days: number): string {
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * One operation id per distinct request. Pressing Save again, or a retry after
 * a dropped connection, sends the same id and the server replays the stored
 * result. Changing any answer is a different request with a new id.
 */
export class OperationKeys {
  private current: { scope: string; key: string } | null = null;
  constructor(private readonly generate: () => string = () => crypto.randomUUID()) {}

  keyFor(scope: unknown): string {
    const text = JSON.stringify(scope);
    if (this.current?.scope !== text) this.current = { scope: text, key: this.generate() };
    return this.current.key;
  }

  reset(): void {
    this.current = null;
  }
}
