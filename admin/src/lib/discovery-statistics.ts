import type { Period } from './statistics';
import type { StatisticsEnquiryWithDiscovery } from './statistics-api';
import { normalizeDiscoverySource } from './discovery-source-registry';

export type DiscoverySourceKey = string;

export interface DiscoveryBreakdownRow {
  key: DiscoverySourceKey;
  count: number;
  share: number;
}

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

    const normalised = normalizeDiscoverySource(enquiry.discovery_source);
    const key: DiscoverySourceKey = normalised ?? 'not_recorded';
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
