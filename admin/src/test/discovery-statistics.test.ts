import { describe, expect, it } from 'vitest';
import { discoveryBreakdown } from '../lib/discovery-statistics';
import type { StatisticsEnquiryWithDiscovery } from '../lib/statistics-api';

function enquiry(
  id: string,
  discovery_source: string | null,
  created_at: string,
): StatisticsEnquiryWithDiscovery {
  return {
    id,
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    client_id: `c${id.padStart(7, '0')}-1111-4111-8111-111111111111`,
    status: 'new',
    source: '/book/vladimir',
    booking_source_id: null,
    communication_channel: null,
    utm_source: null,
    discovery_source,
    created_at,
  };
}

describe('discoveryBreakdown', () => {
  it('counts only the selected period and keeps missing legacy answers explicit', () => {
    const rows = discoveryBreakdown([
      enquiry('1', 'instagram', '2026-09-01T12:00:00.000Z'),
      enquiry('2', 'instagram', '2026-09-02T12:00:00.000Z'),
      enquiry('3', 'chatgpt', '2026-09-03T12:00:00.000Z'),
      enquiry('4', null, '2026-09-04T12:00:00.000Z'),
      enquiry('5', 'google', '2026-08-31T23:59:59.999Z'),
      enquiry('6', 'friend_referral', '2026-09-08T00:00:00.000Z'),
    ], {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-08T00:00:00.000Z',
    });

    expect(rows).toEqual([
      { key: 'instagram', count: 2, share: 50 },
      { key: 'chatgpt', count: 1, share: 25 },
      { key: 'not_recorded', count: 1, share: 25 },
    ]);
  });

  it('treats an unexpected stored value as not recorded rather than inventing attribution', () => {
    expect(discoveryBreakdown([
      enquiry('7', 'something-new', '2026-09-02T12:00:00.000Z'),
    ], {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-08T00:00:00.000Z',
    })).toEqual([
      { key: 'not_recorded', count: 1, share: 100 },
    ]);
  });
});
