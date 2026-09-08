import { describe, expect, it } from 'vitest';
import { durationLabel } from '../components/BookingPanel';

// Small regression guard for the user-facing duration copy used after a custom
// end is selected. The range arithmetic itself is covered through the UI test.
describe('custom booking duration label', () => {
  it('renders non-shortcut durations without exposing raw minutes', () => {
    expect(durationLabel(450, 'en')).toBe('7 h 30 min');
    expect(durationLabel(450, 'ru')).toBe('7 ч 30 мин');
  });
});
