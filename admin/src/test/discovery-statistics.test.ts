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
  it('counts the current booking-form taxonomy inside the selected period', () => {
    const rows = discoveryBreakdown([
      enquiry('1', 'instagram', '2026-09-01T12:00:00.000Z'),
      enquiry('2', 'ai', '2026-09-02T12:00:00.000Z'),
      enquiry('3', 'referral', '2026-09-03T12:00:00.000Z'),
      enquiry('4', 'convention', '2026-09-04T12:00:00.000Z'),
      enquiry('5', 'returning_client', '2026-09-05T12:00:00.000Z'),
      enquiry('6', 'google', '2026-08-31T23:59:59.999Z'),
    ], {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-08T00:00:00.000Z',
    });

    expect(rows).toEqual([
      { key: 'ai', count: 1, share: 20 },
      { key: 'convention', count: 1, share: 20 },
      { key: 'instagram', count: 1, share: 20 },
      { key: 'referral', count: 1, share: 20 },
      { key: 'returning_client', count: 1, share: 20 },
    ]);
  });

  it('keeps legacy form values attributable after the taxonomy migration', () => {
    expect(discoveryBreakdown([
      enquiry('8', 'chatgpt', '2026-09-02T12:00:00.000Z'),
      enquiry('9', 'other_ai', '2026-09-03T12:00:00.000Z'),
      enquiry('10', 'friend_referral', '2026-09-04T12:00:00.000Z'),
      enquiry('11', null, '2026-09-05T12:00:00.000Z'),
      enquiry('12', 'something-new', '2026-09-06T12:00:00.000Z'),
    ], {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-08T00:00:00.000Z',
    })).toEqual([
      { key: 'ai', count: 2, share: 40 },
      { key: 'not_recorded', count: 2, share: 40 },
      { key: 'referral', count: 1, share: 20 },
    ]);
  });
});
