import { normalizeDiscoverySource } from './discovery-source-registry';

export type DiscoverySourceKey = string;

export interface DiscoveryBreakdownRow {
  key: DiscoverySourceKey;
  count: number;
  share: number;
}

/**
 * Self-reported discovery attribution, from the counts the server returns
 * (statistics_core.discovery, raw values per enquiry of the period).
 *
 * Independent from the technical channel: this answers only what the client
 * selected in the booking form. Historical aliases are merged through the
 * registry; an unknown non-empty value stays its own row.
 */
export function discoveryBreakdown(counts: Record<string, number>): DiscoveryBreakdownRow[] {
  const merged = new Map<DiscoverySourceKey, number>();
  for (const [raw, count] of Object.entries(counts ?? {})) {
    const key = raw === 'not_recorded' ? 'not_recorded' : normalizeDiscoverySource(raw) ?? 'not_recorded';
    merged.set(key, (merged.get(key) ?? 0) + Number(count));
  }
  const total = [...merged.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];
  return [...merged.entries()]
    .map(([key, count]) => ({ key, count, share: (count / total) * 100 }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
