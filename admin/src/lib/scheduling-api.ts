// Artist scheduling preferences, per-day overrides, and the policy-aware
// conflict read.
//
// All four go through RPCs granted to `authenticated` that re-check
// `require_artist_access` inside the database (0120). The tables themselves
// are closed to every browser role, so there is no direct-table path to
// widen.

import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { AppointmentType } from './appointment-api';

/** Times are 'HH:MM' strings, because that is what an operator edits. */
export interface SchedulingPreferences {
  artist_id: string;
  tattoo_earliest_start: string;
  tattoo_latest_finish: string;
  tattoo_preferred_starts: string[];
  consultation_earliest_start: string;
  consultation_latest_finish: string;
  /** The rule that lets a consultation run alongside a tattoo session. */
  consultation_during_tattoo: boolean;
  max_concurrent_consultations: number;
  /** False when the artist is still on the database defaults. */
  is_stored: boolean;
}

export interface ScheduleOverride {
  override_id: string;
  artist_id: string;
  on_date: string;
  tattoo_earliest_start: string | null;
  tattoo_latest_finish: string | null;
  note: string | null;
}

export interface BookingConflict {
  appointment_id: string;
  appointment_type: AppointmentType;
  status: string;
  start_at: string;
  end_at: string;
  client_id: string | null;
  enquiry_id: string | null;
  project_id: string | null;
  /**
   * Whether this overlap would actually refuse the booking. A consultation
   * overlapping a tattoo session is reported but does not block, so the
   * interface can say "also happening then" without crying wolf.
   */
  blocks: boolean;
}

export function createSchedulingApi(client: CrmClient) {
  return {
    async getSchedulingPreferences(artistId: string): Promise<SchedulingPreferences> {
      const result = await client.rpc('get_artist_scheduling_preferences', {
        p_artist_id: artistId,
      });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load scheduling preferences'), result.error);
      }
      return result.data as unknown as SchedulingPreferences;
    },

    async setSchedulingPreferences(input: {
      artistId: string;
      tattooEarliestStart: string;
      tattooLatestFinish: string;
      tattooPreferredStarts: string[];
      consultationEarliestStart: string;
      consultationLatestFinish: string;
      consultationDuringTattoo: boolean;
      maxConcurrentConsultations: number;
    }): Promise<SchedulingPreferences> {
      const result = await client.rpc('set_artist_scheduling_preferences', {
        p_artist_id: input.artistId,
        p_tattoo_earliest_start: input.tattooEarliestStart,
        p_tattoo_latest_finish: input.tattooLatestFinish,
        p_tattoo_preferred_starts: input.tattooPreferredStarts,
        p_consultation_earliest_start: input.consultationEarliestStart,
        p_consultation_latest_finish: input.consultationLatestFinish,
        p_consultation_during_tattoo: input.consultationDuringTattoo,
        p_max_concurrent_consultations: input.maxConcurrentConsultations,
      });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'save scheduling preferences'), result.error);
      }
      return result.data as unknown as SchedulingPreferences;
    },

    async listScheduleOverrides(input: {
      artistId: string;
      from: string;
      to: string;
    }): Promise<ScheduleOverride[]> {
      const result = await client.rpc('list_artist_schedule_overrides', {
        p_artist_id: input.artistId,
        p_from: input.from,
        p_to: input.to,
      });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load schedule overrides'), result.error);
      }
      return (result.data ?? []) as unknown as ScheduleOverride[];
    },

    async setScheduleOverride(input: {
      artistId: string;
      onDate: string;
      tattooEarliestStart?: string | null;
      tattooLatestFinish?: string | null;
      note?: string | null;
    }): Promise<void> {
      const result = await client.rpc('set_artist_schedule_override', {
        p_artist_id: input.artistId,
        p_on_date: input.onDate,
        p_tattoo_earliest_start: input.tattooEarliestStart ?? null,
        p_tattoo_latest_finish: input.tattooLatestFinish ?? null,
        p_note: input.note ?? null,
      });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'save that schedule override'), result.error);
      }
    },

    /**
     * What else is in the diary here, and whether any of it would refuse the
     * booking. The same policy the write path enforces decides `blocks`, so
     * the warning and the refusal cannot disagree.
     */
    async listBookingConflicts(input: {
      artistId: string;
      appointmentType: AppointmentType;
      startAt: string;
      endAt: string;
      excludeAppointmentId?: string | null;
    }): Promise<BookingConflict[]> {
      const result = await client.rpc('list_booking_conflicts', {
        p_artist_id: input.artistId,
        p_appointment_type: input.appointmentType,
        p_start_at: input.startAt,
        p_end_at: input.endAt,
        p_exclude_appointment_id: input.excludeAppointmentId ?? null,
      });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'check booking conflicts'), result.error);
      }
      return (result.data ?? []) as unknown as BookingConflict[];
    },
  };
}

export type SchedulingApi = ReturnType<typeof createSchedulingApi>;
