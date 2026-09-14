import type { Period } from './statistics';
import type { StatisticsEnquiryWithDiscovery } from './statistics-api';

export const DISCOVERY_SOURCE_KEYS = [
  'instagram',
  'google',
  'ai',
  'referral',
  'convention',
  'returning_client',
  'other',
] as const;

export type DiscoverySourceKey = (typeof DISCOVERY_SOURCE_KEYS)[number] | 'not_recorded';

export interface DiscoveryBreakdownRow {
  key: DiscoverySourceKey;
  count: number;
  share: number;
}

const KNOWN = new Set<string>(DISCOVERY_SOURCE_KEYS);

// Older booking forms stored these values before discovery attribution was
// normalised to the current seven-category taxonomy. Keep them readable so a
// form migration never makes historical attribution disappear from statistics.
const LEGACY_ALIASES: Record<string, (typeof DISCOVERY_SOURCE_KEYS)[number]> = {
  chatgpt: 'ai',
  other_ai: 'ai',
  friend_referral: 'referral',
};

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
    const normalised = LEGACY_ALIASES[raw] ?? raw;
    const key: DiscoverySourceKey = KNOWN.has(normalised)
      ? normalised as DiscoverySourceKey
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
