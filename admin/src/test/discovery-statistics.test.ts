import { describe, expect, it } from 'vitest';
import { discoveryBreakdown } from '../lib/discovery-statistics';
import { discoverySourceLabel } from '../lib/discovery-source-registry';

describe('discoveryBreakdown', () => {
  it('reports the server counts of the current booking-form taxonomy as shares', () => {
    expect(discoveryBreakdown({ instagram: 1, ai: 1, referral: 1, convention: 1, returning_client: 1 })).toEqual([
      { key: 'ai', count: 1, share: 20 },
      { key: 'convention', count: 1, share: 20 },
      { key: 'instagram', count: 1, share: 20 },
      { key: 'referral', count: 1, share: 20 },
      { key: 'returning_client', count: 1, share: 20 },
    ]);
  });

  it('keeps legacy form values attributable after the taxonomy migration', () => {
    expect(discoveryBreakdown({
      chatgpt: 1,
      other_ai: 1,
      friend_referral: 1,
      not_recorded: 1,
      'something-new': 1,
    })).toEqual([
      { key: 'ai', count: 2, share: 40 },
      { key: 'not_recorded', count: 1, share: 20 },
      { key: 'referral', count: 1, share: 20 },
      { key: 'something-new', count: 1, share: 20 },
    ]);
  });

  it('is empty when the period holds no enquiries', () => {
    expect(discoveryBreakdown({})).toEqual([]);
  });

  it('keeps future categories visible even before a friendly label is added', () => {
    expect(discoverySourceLabel('tiktok_social', 'en')).toBe('Tiktok social');
    expect(discoverySourceLabel('tiktok_social', 'ru')).toBe('Tiktok social');
  });
});
