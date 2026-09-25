// The server-side Today pulse (Phase 4).
//
// `get_today_pulse` answers "what needs me today" in the database, from the
// same rules the browser list used plus the deterministic attention layer:
// contradictory records, clients who went quiet, unknown senders. Telegram
// /today reads the same items, so the two surfaces cannot disagree.
//
// The CRM renders it only while `enabled` is true (crm_agent_config.today_pulse).
// Until then, or if the read fails, Today keeps computing its list locally.

import { apiMessage, ApiError, friendlyMessage, type CrmClient } from './api';
import type { AttentionAcknowledgementKind, AttentionItemRef } from './attention-api';
import type { TodayItem, TodayItemKind } from './today-workspace';

export interface PulseAiSuggestion {
  id: string;
  action_type: string;
  reason: string | null;
}

export interface PulseItem {
  key: string;
  kind: TodayItemKind;
  section: 'waiting_for_you' | 'inbox' | 'conflicts' | 'waiting_on_clients' | 'system';
  reason: string;
  artist_id: string;
  client_id: string | null;
  subject: string | null;
  href: string | null;
  at: string | null;
  detail: string | null;
  sla_state: string | null;
  ai_suggestion: PulseAiSuggestion | null;
  acknowledgement: { kind: AttentionAcknowledgementKind; entity_id: string; observed_at: string } | null;
  urgent: boolean;
}

export interface PulseArtistSummary {
  artist_id: string;
  artist_name: string;
  changes: {
    new_enquiries: number;
    inbound_messages: number;
    sessions_booked: number;
    payments_received: number;
  };
  median_first_reply_hours: number | null;
  enquiries_without_reply_30d: number;
  sources: { gmail_snapshot: 'fresh' | 'stale' | 'unavailable'; gmail_refreshed_at: string | null };
}

export interface TodayPulse {
  generated_at: string;
  enabled: boolean;
  items: PulseItem[];
  artists: PulseArtistSummary[];
}

const KINDS = new Set<TodayItemKind>([
  'reschedule_requested', 'reply', 'email_send_failed', 'email_draft_to_approve', 'payment_to_confirm',
  'unconfirmed_appointment', 'deposit_outstanding', 'new_enquiry', 'overdue_follow_up',
  'integration_failure', 'conflict', 'unmatched_inbound', 'client_follow_up_due', 'client_cold',
]);

/**
 * Server items as Today rows. A kind this build does not know is dropped
 * rather than rendered with a raw code; the database may be newer than the
 * page for a few minutes during a release.
 */
export function pulseToTodayItems(pulse: TodayPulse): TodayItem[] {
  const items: TodayItem[] = [];
  for (const item of pulse.items) {
    if (!KINDS.has(item.kind)) continue;
    const ack: AttentionItemRef | null = item.acknowledgement
      ? {
        artistId: item.artist_id,
        kind: item.acknowledgement.kind,
        entityId: item.acknowledgement.entity_id,
        observedAt: item.acknowledgement.observed_at,
      }
      : null;
    items.push({
      key: item.key,
      kind: item.kind,
      href: item.href,
      subject: item.subject,
      at: item.at,
      detail: item.detail,
      urgent: item.urgent,
      acknowledgement: ack,
      reason: item.reason,
      aiSuggestion: item.ai_suggestion,
    });
  }
  return items;
}

export function createTodayPulseApi(client: CrmClient) {
  return {
    async getTodayPulse(artistId?: string): Promise<TodayPulse> {
      const result = await client.rpc('get_today_pulse', { p_artist_id: artistId ?? null });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load today'), result.error);
      }
      const data = result.data as TodayPulse | null;
      if (!data || !Array.isArray(data.items)) throw new ApiError(apiMessage('Could not load today.'));
      return data;
    },
  };
}

export type TodayPulseApi = ReturnType<typeof createTodayPulseApi>;
