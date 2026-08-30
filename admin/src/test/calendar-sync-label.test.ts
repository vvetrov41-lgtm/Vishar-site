// The calendar row has to say what to do, not what the worker called it.
//
// Both pages that show a booking used to end a failed row with the drain's own
// code - "Calendar: failed: calendar_oauth_expired". It is safe to display, and
// it is useless: it does not say whether the client's booking reached Google,
// and it does not say who can fix it.

import { describe, expect, it } from 'vitest';
import { calendarSyncLabel, remedyFor } from '../lib/calendar-sync';

function appointment(
  calendar_sync_status: 'not_connected' | 'queued' | 'synced' | 'retrying' | 'failed',
  calendar_last_error_code: string | null = null,
) {
  return { calendar_sync_status, calendar_last_error_code };
}

describe('calendar sync label', () => {
  it('never shows the drain error code to an operator', () => {
    for (const code of [
      'calendar_oauth_expired',
      'calendar_provider_rejected',
      'calendar_connector_error',
      'something_the_worker_invented_later',
    ]) {
      for (const language of ['en', 'ru'] as const) {
        expect(calendarSyncLabel(appointment('failed', code), language)).not.toContain(code);
        expect(calendarSyncLabel(appointment('failed', code), language)).not.toMatch(/_/);
      }
    }
  });

  it('sends an expired connection to the screen that can reconnect it', () => {
    expect(calendarSyncLabel(appointment('failed', 'calendar_oauth_expired'), 'en'))
      .toBe('failed — reconnect the calendar in Integrations');
    expect(calendarSyncLabel(appointment('failed', 'calendar_token_invalid'), 'ru'))
      .toBe('ошибка — переподключите календарь в разделе «Интеграции»');
  });

  it('distinguishes a failure that will retry itself from one that will not', () => {
    expect(calendarSyncLabel(appointment('failed', 'calendar_provider_unavailable'), 'en'))
      .toBe('failed — Google did not answer — it will try again');
    expect(calendarSyncLabel(appointment('failed', 'calendar_provider_rejected'), 'en'))
      .toBe('failed — Google refused this change');
  });

  it('falls back to the one screen that can fix a calendar, for a code it has never seen', () => {
    // The worker can add a code without this table knowing about it. That must
    // still produce an instruction, not an identifier.
    expect(remedyFor('a_code_added_next_year')).toBe('unknown');
    expect(remedyFor(null)).toBe('unknown');
    expect(calendarSyncLabel(appointment('failed', 'a_code_added_next_year'), 'ru'))
      .toBe('ошибка — проверьте подключения календаря в разделе «Интеграции»');
  });

  it('leaves a healthy booking as a single word', () => {
    expect(calendarSyncLabel(appointment('synced'), 'en')).toBe('synced');
    expect(calendarSyncLabel(appointment('queued'), 'ru')).toBe('в очереди');
    expect(calendarSyncLabel(appointment('not_connected'), 'ru')).toBe('не подключён');
    // A stale code on a recovered booking must not resurface.
    expect(calendarSyncLabel(appointment('synced', 'calendar_oauth_expired'), 'en')).toBe('synced');
  });
});
