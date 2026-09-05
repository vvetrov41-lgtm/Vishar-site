import type { Period } from './statistics';
import type { StatisticsEnquiryWithDiscovery } from './statistics-api';

export const DISCOVERY_SOURCE_KEYS = [
  'instagram',
  'chatgpt',
  'other_ai',
  'friend_referral',
  'google',
  'other',
] as const;

export type DiscoverySourceKey = (typeof DISCOVERY_SOURCE_KEYS)[number] | 'not_recorded';

export interface DiscoveryBreakdownRow {
  key: DiscoverySourceKey;
  count: number;
  share: number;
}

const KNOWN = new Set<string>(DISCOVERY_SOURCE_KEYS);

/**
 * Self-reported discovery attribution for enquiries created inside `period`.
 *
 * This is intentionally independent from `sourceBreakdown()`. Booking source,
 * UTM and communication channel answer where a request technically arrived;
 * this function answers only what the client selected in the booking form.
 */
export function discoveryBreakdown(
  enquiries: StatisticsEnquiryWithDiscovery[],
  period: Period,
): DiscoveryBreakdownRow[] {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  const counts = new Map<DiscoverySourceKey, number>();

  for (const enquiry of enquiries) {
    const created = Date.parse(enquiry.created_at);
    if (created < from || created >= to) continue;

    const raw = enquiry.discovery_source ?? '';
    const key: DiscoverySourceKey = KNOWN.has(raw)
      ? raw as DiscoverySourceKey
      : 'not_recorded';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];

  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      share: (count / total) * 100,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
