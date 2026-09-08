import { describe, expect, it } from 'vitest';
import { addMinutesLocal, snapLocalDateTime } from '../components/BookingPanel';

describe('manual booking time helpers', () => {
  it('snaps manually chosen times to five-minute boundaries', () => {
    expect(snapLocalDateTime('2026-09-08T08:52')).toBe('2026-09-08T08:50');
    expect(snapLocalDateTime('2026-09-08T08:53')).toBe('2026-09-08T08:55');
    expect(snapLocalDateTime('2026-09-08T08:55')).toBe('2026-09-08T08:55');
  });

  it('can ceil an automatically initialized time to the next five-minute boundary', () => {
    expect(snapLocalDateTime('2026-09-08T08:52', 5, 'ceil')).toBe('2026-09-08T08:55');
  });

  it('derives the end from the selected duration instead of an independent end value', () => {
    expect(addMinutesLocal('2026-09-08T09:00', 420)).toBe('2026-09-08T16:00');
    expect(addMinutesLocal('2026-09-08T09:05', 180)).toBe('2026-09-08T12:05');
  });
});
