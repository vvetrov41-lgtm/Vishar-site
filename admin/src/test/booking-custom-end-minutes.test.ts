import { describe, expect, it } from 'vitest';
import { MANUAL_MINUTE_OPTIONS } from '../lib/manual-time-control';

describe('custom booking end minute choices', () => {
  it('uses the same deterministic five-minute options as the start', () => {
    expect(MANUAL_MINUTE_OPTIONS).toEqual([
      '00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55',
    ]);
  });
});
