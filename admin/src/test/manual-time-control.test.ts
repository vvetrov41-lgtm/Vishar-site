import { describe, expect, it } from 'vitest';
import {
  composeManualDateTime,
  MANUAL_HOUR_OPTIONS,
  MANUAL_MINUTE_OPTIONS,
  splitManualDateTime,
} from '../lib/manual-time-control';

describe('manual booking time control', () => {
  it('exposes only five-minute choices', () => {
    expect(MANUAL_MINUTE_OPTIONS).toEqual([
      '00', '05', '10', '15', '20', '25',
      '30', '35', '40', '45', '50', '55',
    ]);
    expect(MANUAL_HOUR_OPTIONS).toHaveLength(24);
  });

  it('normalises arbitrary browser minutes forward to a legal choice', () => {
    expect(splitManualDateTime('2026-09-08T15:08', '2026-09-08')).toEqual({
      date: '2026-09-08',
      hour: '15',
      minute: '10',
    });
    expect(splitManualDateTime('2026-09-08T22:09', '2026-09-08')).toEqual({
      date: '2026-09-08',
      hour: '22',
      minute: '10',
    });
  });

  it('rolls 23:58 to midnight on the next date', () => {
    expect(splitManualDateTime('2026-09-08T23:58', '2026-09-08')).toEqual({
      date: '2026-09-09',
      hour: '00',
      minute: '00',
    });
  });

  it('refuses minute values outside the deterministic option list', () => {
    expect(composeManualDateTime({ date: '2026-09-08', hour: '15', minute: '08' })).toBe('');
    expect(composeManualDateTime({ date: '2026-09-08', hour: '15', minute: '10' }))
      .toBe('2026-09-08T15:10');
  });
});
