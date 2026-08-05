import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import { createCalendarConnectionsApi } from '../lib/calendar-connections-api';
import { calendarConnectionHealth } from '../pages/CalendarConnectionsPage';

const VALID = {
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  artist_slug: 'vladimir',
  artist_display_name: 'Vladimir',
  provider: 'google',
  integration_key: 'google_calendar_vladimir',
  connected: true,
  external_account_label: 'calendar-account@example.test',
  connection_updated_at: '2026-08-05T12:00:00.000Z',
  last_successful_sync_at: null,
  queued_jobs: 1,
  retrying_jobs: 0,
  failed_jobs: 0,
  last_error_code: null,
};

function apiFor(data: unknown) {
  const rpc = vi.fn(async () => ({ data, error: null }));
  return createCalendarConnectionsApi({ rpc } as unknown as CrmClient);
}

describe('Calendar Connections hardening', () => {
  it('rejects malformed nullable metadata and unsafe counters', async () => {
    const malformed = [
      { ...VALID, external_account_label: 42 },
      { ...VALID, connection_updated_at: 'not-a-date' },
      { ...VALID, queued_jobs: -1 },
      { ...VALID, last_error_code: 'Unsafe Error!' },
    ];

    for (const row of malformed) {
      await expect(apiFor([row]).listCalendarConnectionStatus()).rejects.toThrow(
        'Could not load calendar connections',
      );
    }
  });

  it('rejects duplicate aliases and impossible result sizes', async () => {
    const kristina = {
      ...VALID,
      artist_id: 'a2222222-2222-4222-8222-222222222222',
      artist_slug: 'kristina',
      artist_display_name: 'Kristina',
      integration_key: 'google_calendar_kristina',
    };

    await expect(apiFor([VALID, { ...VALID }]).listCalendarConnectionStatus()).rejects.toThrow();
    await expect(apiFor([
      VALID,
      kristina,
      { ...kristina, artist_id: 'a3333333-3333-4333-8333-333333333333' },
    ]).listCalendarConnectionStatus()).rejects.toThrow();
  });

  it('maps permanent OAuth failures to reconnect rather than healthy', () => {
    expect(calendarConnectionHealth({
      connected: true,
      failed_jobs: 1,
      last_error_code: 'calendar_oauth_expired',
    })).toBe('reconnect');
    expect(calendarConnectionHealth({
      connected: true,
      failed_jobs: 1,
      last_error_code: 'calendar_provider_rejected',
    })).toBe('attention');
    expect(calendarConnectionHealth({
      connected: true,
      failed_jobs: 0,
      last_error_code: null,
    })).toBe('connected');
    expect(calendarConnectionHealth({
      connected: false,
      failed_jobs: 0,
      last_error_code: null,
    })).toBe('disconnected');
  });
});
