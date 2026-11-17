import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { AppointmentType } from './appointment-api';

export type SlotState = 'open' | 'past' | 'taken' | 'not_cancelled';
export type SlotCandidateReason =
  | 'deposit_paid_no_date'
  | 'open_follow_up'
  | 'touch_up_due'
  | 'project_no_date'
  | 'enquiry_awaiting_consultation';
export type SlotFit = 'fits' | 'longer' | 'unknown';

export interface SlotCandidate {
  client_id: string;
  client_name: string;
  reason: SlotCandidateReason;
  project_id: string | null;
  enquiry_id: string | null;
  follow_up_id: string | null;
  needed_hours: number | null;
  fit: SlotFit;
  phone: string | null;
  email: string | null;
  instagram: string | null;
  preferred_contact: string | null;
  draft_message: string;
}

export interface CancelledSlotCandidates {
  slot: {
    session_id: string;
    artist_id: string;
    appointment_type: AppointmentType;
    start_at: string;
    end_at: string;
    duration_hours: number;
    timezone: string;
    state: SlotState;
  };
  candidates: SlotCandidate[];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read-only: lists who could take a cancelled slot. Never sends or books anything. */
export function createCancelledSlotApi(client: CrmClient) {
  return {
    async listCancelledSlotCandidates(sessionId: string): Promise<CancelledSlotCandidates> {
      const result = await client.rpc('list_cancelled_slot_candidates', { p_session_id: sessionId });
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load slot candidates'), result.error);
      const data = result.data as any;
      if (!data || typeof data !== 'object' || !data.slot) {
        throw new ApiError(friendlyMessage(null, 'load slot candidates'));
      }
      return {
        slot: { ...data.slot, duration_hours: Number(data.slot.duration_hours ?? 0) },
        candidates: Array.isArray(data.candidates)
          ? data.candidates.map((c: any) => ({ ...c, needed_hours: numberOrNull(c.needed_hours) }))
          : [],
      };
    },
  };
}

export type CancelledSlotApi = ReturnType<typeof createCancelledSlotApi>;
