// Visit outcomes: what actually happened at a tattoo session or consultation.
//
// The database owns every rule (timing, status transitions, money, access):
// see supabase/migrations/20261113180000_visit_outcomes.sql. The browser only
// collects the artist's answer and sends it with an operation id, so pressing
// "Save" twice, or a retry after a dropped connection, records one outcome.

import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { AppointmentType } from './appointment-api';
import type { SessionStatus } from './types';

export type TattooOutcome = 'attended' | 'no_show' | 'cancelled';
export type ConsultationOutcome = 'booked' | 'ready_to_book' | 'thinking' | 'declined' | 'no_show';
export type VisitOutcomeValue = TattooOutcome | ConsultationOutcome;
export type WorkResult = 'work_complete' | 'next_session_needed' | 'touch_up_needed';
export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'other';
export type VisitPaymentState = 'paid' | 'part_paid' | 'unpaid' | 'needs_review' | 'not_recorded';

export type FinanceWarning =
  | 'unallocated_deposit' | 'unlinked_invoice' | 'mixed_invoice' | 'currency_mismatch'
  | 'overpaid' | 'credited_invoice';

export interface VisitFinance {
  currency: string;
  price: number | null;
  stored_price: number | null;
  deposit_paid: number;
  invoiced_paid: number;
  due: number | null;
  warnings: FinanceWarning[];
  session_invoice_count: number;
  payable_invoice_id: string | null;
  hourly_rate: number | null;
  project_currency: string | null;
}

export interface StoredVisitOutcome {
  state: 'deferred' | 'confirmed';
  outcome: VisitOutcomeValue | null;
  work_result: WorkResult | null;
  worked_minutes: number | null;
  linked_session_id: string | null;
  follow_up_id: string | null;
  notes: string | null;
  aftercare_sent_before_outcome: boolean | null;
  deferred_until: string | null;
  version: number;
  confirmed_at: string | null;
  updated_at: string;
  final_price?: number | null;
  received_via_outcome?: number;
  outstanding?: number | null;
  payment_state?: VisitPaymentState | null;
  payment_method?: PaymentMethod | null;
  paid_outside_crm?: boolean;
}

export interface VisitBooking {
  id: string;
  appointment_type: AppointmentType;
  status: SessionStatus;
  start_at: string;
  end_at: string;
  project_id: string | null;
}

export interface VisitOutcomeContext {
  session: {
    id: string;
    artist_id: string;
    client_id: string;
    client_name: string | null;
    appointment_type: AppointmentType;
    status: SessionStatus;
    start_at: string;
    end_at: string;
    scheduled_minutes: number;
    project_id: string | null;
    enquiry_id: string | null;
    enquiry_status: string | null;
    currency: string;
    payment_status?: string;
  };
  outcome: StoredVisitOutcome | null;
  version: number;
  finance: VisitFinance | null;
  bookings: VisitBooking[] | null;
  aftercare_sent: boolean | null;
  can: { record: boolean; finance: boolean; follow_up: boolean; view_finance: boolean };
  needs_review: boolean;
  server_time: string;
}

export interface RecordVisitOutcomeInput {
  sessionId: string;
  operationId: string;
  expectedVersion: number;
  outcome: VisitOutcomeValue;
  details: {
    worked_minutes?: number;
    final_price?: number;
    received_now?: number;
    payment_method?: PaymentMethod;
    paid_outside_crm?: boolean;
    work_result?: WorkResult;
    notes?: string;
    linked_session_id?: string;
    follow_up_at?: string;
    close_enquiry?: boolean;
  };
}

export interface RecordVisitOutcomeResult {
  session_id: string;
  outcome: VisitOutcomeValue;
  state: 'confirmed';
  version: number;
  correction: boolean;
  session_status: SessionStatus;
  payment_state: VisitPaymentState | null;
  aftercare_already_sent: boolean;
  replayed: boolean;
}

export interface VisitHistoryEntry {
  version: number;
  action: 'defer' | 'confirm' | 'correct';
  created_at: string;
  created_by_name: string | null;
  outcome: VisitOutcomeValue | null;
  work_result: WorkResult | null;
  deferred_until: string | null;
  status_to: SessionStatus | null;
  final_price?: number | null;
  payment_state?: VisitPaymentState | null;
}

export interface ClientVisitOutcome {
  session_id: string;
  state: 'deferred' | 'confirmed';
  outcome: VisitOutcomeValue | null;
  work_result: WorkResult | null;
  confirmed_at: string | null;
  version: number;
}

/**
 * Why the database refused, so the card can say it in the artist's language
 * instead of a generic failure. Money rules are explained, never bypassed.
 */
export type VisitOutcomeRefusal =
  | 'stale'
  | 'over_balance'
  | 'needs_review'
  | 'money_recorded'
  | 'finance_access'
  | 'permission'
  | 'not_started'
  | 'not_finished'
  | 'booking_required'
  | 'closed'
  | 'already_confirmed'
  | 'price_below_paid'
  | 'invalid'
  | 'unavailable'
  | 'unknown';

export class VisitOutcomeError extends ApiError {
  constructor(message: string, public readonly refusal: VisitOutcomeRefusal, cause?: unknown) {
    super(message, cause);
    this.name = 'VisitOutcomeError';
  }
}

export function classifyVisitOutcomeError(error: unknown): VisitOutcomeRefusal {
  const code = readString(error, 'code');
  const message = readString(error, 'message').toLowerCase();
  if (code === 'PGRST202' || code === '42883') return 'unavailable';
  if (code === '40001' || message.includes('changed in another session')) return 'stale';
  if (message.includes('requires finance access')) return 'finance_access';
  if (code === '42501' || code === 'PGRST301') return 'permission';
  if (message.includes('more than the remaining balance') || message.includes('more than the invoice')) return 'over_balance';
  if (message.includes('need review') || message.includes('does not match the balance')) return 'needs_review';
  if (message.includes('money was recorded')) return 'money_recorded';
  if (message.includes('lower than money already recorded')) return 'price_below_paid';
  if (message.includes('has not started')) return 'not_started';
  if (message.includes('has not finished')) return 'not_finished';
  if (message.includes('existing tattoo booking')) return 'booking_required';
  if (message.includes('already closed')) return 'closed';
  if (message.includes('already confirmed')) return 'already_confirmed';
  if (code === '22023' || code === '23514') return 'invalid';
  return 'unknown';
}

function readString(error: unknown, key: 'code' | 'message'): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normaliseFinance(raw: any): VisitFinance | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    currency: String(raw.currency ?? 'GBP'),
    price: numberOrNull(raw.price),
    stored_price: numberOrNull(raw.stored_price),
    deposit_paid: numberOrNull(raw.deposit_paid) ?? 0,
    invoiced_paid: numberOrNull(raw.invoiced_paid) ?? 0,
    due: numberOrNull(raw.due),
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    session_invoice_count: Number(raw.session_invoice_count ?? 0),
    payable_invoice_id: raw.payable_invoice_id ?? null,
    hourly_rate: numberOrNull(raw.hourly_rate),
    project_currency: raw.project_currency ?? null,
  };
}

export function createVisitOutcomeApi(client: CrmClient) {
  async function call<T>(fn: string, args: Record<string, unknown>,
    what: 'load that visit outcome' | 'save that visit outcome' | 'postpone that visit outcome' | 'load the visit history'): Promise<T> {
    const result = await client.rpc(fn, args);
    if (result.error) {
      throw new VisitOutcomeError(friendlyMessage(result.error, what), classifyVisitOutcomeError(result.error), result.error);
    }
    return result.data as T;
  }

  return {
    async getVisitOutcomeContext(sessionId: string): Promise<VisitOutcomeContext> {
      const data = await call<any>('get_visit_outcome_context', { p_session_id: sessionId }, 'load that visit outcome');
      if (!data || typeof data !== 'object' || !data.session) {
        throw new VisitOutcomeError(friendlyMessage(null, 'load that visit outcome'), 'unknown');
      }
      return {
        ...data,
        version: Number(data.version ?? 0),
        finance: normaliseFinance(data.finance),
        outcome: data.outcome ?? null,
        bookings: Array.isArray(data.bookings) ? data.bookings : null,
      } as VisitOutcomeContext;
    },

    async recordVisitOutcome(input: RecordVisitOutcomeInput): Promise<RecordVisitOutcomeResult> {
      return call<RecordVisitOutcomeResult>('record_visit_outcome', {
        p_session_id: input.sessionId,
        p_operation_id: input.operationId,
        p_expected_version: input.expectedVersion,
        p_outcome: input.outcome,
        p_details: input.details,
      }, 'save that visit outcome');
    },

    async deferVisitOutcome(input: { sessionId: string; operationId: string; expectedVersion: number; until: string }) {
      return call<{ state: 'deferred'; deferred_until: string; version: number; replayed: boolean }>('defer_visit_outcome', {
        p_session_id: input.sessionId,
        p_operation_id: input.operationId,
        p_expected_version: input.expectedVersion,
        p_until: input.until,
      }, 'postpone that visit outcome');
    },

    async listVisitOutcomeHistory(sessionId: string): Promise<VisitHistoryEntry[]> {
      const data = await call<VisitHistoryEntry[] | null>('list_visit_outcome_history', { p_session_id: sessionId }, 'load the visit history');
      return Array.isArray(data) ? data : [];
    },

    async listClientVisitOutcomes(clientId: string): Promise<ClientVisitOutcome[]> {
      const data = await call<ClientVisitOutcome[] | null>('list_client_visit_outcomes', { p_client_id: clientId }, 'load the visit history');
      return Array.isArray(data) ? data : [];
    },
  };
}

export type VisitOutcomeApi = ReturnType<typeof createVisitOutcomeApi>;
