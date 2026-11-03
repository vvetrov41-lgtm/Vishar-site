import { describe, expect, it } from 'vitest';
import type { OutboxJob } from './types';
import { safeDeliveryErrorCode, splitDeliveryIssues } from './integration-issues';

const createJob = (id: string, last_error_code: string | null): OutboxJob => ({
  id,
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  kind: 'approved_email',
  status: 'dead',
  attempt_count: 0,
  max_attempts: 8,
  next_attempt_at: '2026-11-03T00:00:00Z',
  last_error_code,
  updated_at: '2026-11-03T00:00:00Z',
});

describe('delivery diagnostics', () => {
  it('separates intentional cancellations from actual failed deliveries', () => {
    const { actionable, cancelled } = splitDeliveryIssues([
      createJob('cancelled', 'operator_cancelled'),
      createJob('direct', 'cancelled_by_artist_for_direct_gmail_send'),
      createJob('real', 'provider_unavailable'),
      createJob('unknown', null),
    ]);
    expect(cancelled.map((x) => x.id)).toEqual(['cancelled', 'direct']);
    expect(actionable.map((x) => x.id)).toEqual(['real', 'unknown']);
  });

  it('never renders provider-supplied arbitrary text as an error code', () => {
    expect(safeDeliveryErrorCode('provider_unavailable')).toBe('provider_unavailable');
    expect(safeDeliveryErrorCode('<script>')).toBe('unknown_delivery_error');
    expect(safeDeliveryErrorCode(null)).toBe('unknown_delivery_error');
  });
});
