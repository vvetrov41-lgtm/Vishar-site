import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import { createCalendarConnectionsApi } from '../lib/calendar-connections-api';
import { can, navItemsFor } from '../lib/permissions';
import {
  calendarConnectorUrl,
  connectionResultNotice,
} from '../pages/CalendarConnectionsPage';

const VLADIMIR = {
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  artist_slug: 'vladimir',
  artist_display_name: 'Vladimir',
  provider: 'google',
  integration_key: 'google_calendar_vladimir',
  connected: true,
  external_account_label: 'vladimir@example.test',
  connection_updated_at: '2026-08-05T12:00:00.000Z',
  last_successful_sync_at: null,
  queued_jobs: 1,
  retrying_jobs: 0,
  failed_jobs: 0,
  last_error_code: null,
};

describe('Calendar Connections API boundary', () => {
  it('uses only the narrow metadata RPC', async () => {
    const rpc = vi.fn(async () => ({ data: [VLADIMIR], error: null }));
    const api = createCalendarConnectionsApi({ rpc } as unknown as CrmClient);

    await expect(api.listCalendarConnectionStatus()).resolves.toEqual([VLADIMIR]);
    expect(rpc).toHaveBeenCalledWith('list_calendar_connection_status');
  });

  it('fails closed when artist routing does not match the exact connector key', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ ...VLADIMIR, integration_key: 'google_calendar_kristina' }],
      error: null,
    }));
    const api = createCalendarConnectionsApi({ rpc } as unknown as CrmClient);

    await expect(api.listCalendarConnectionStatus()).rejects.toThrow(
      'Could not load calendar connections',
    );
  });

  it('does not accept an unknown provider or artist alias', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ ...VLADIMIR, provider: 'other', artist_slug: 'shared' }],
      error: null,
    }));
    const api = createCalendarConnectionsApi({ rpc } as unknown as CrmClient);

    await expect(api.listCalendarConnectionStatus()).rejects.toThrow();
  });
});

describe('Calendar Connections navigation', () => {
  it('uses only the explicitly configured connector origin without artist ids, emails or tokens', () => {
    const origin = 'https://calendar-staging.vishartattoo.com';
    const start = calendarConnectorUrl(origin, 'start', 'vladimir');
    const disconnect = calendarConnectorUrl(origin, 'disconnect', 'kristina');

    expect(start).toBe(
      'https://calendar-staging.vishartattoo.com/oauth/google/start/vladimir',
    );
    expect(disconnect).toBe(
      'https://calendar-staging.vishartattoo.com/oauth/google/disconnect/kristina',
    );
    expect(`${start}${disconnect}`).not.toMatch(/artist_id|@|token|calendar_id/i);
  });

  it('refuses to synthesize a connector URL when the environment has no connector', () => {
    expect(() => calendarConnectorUrl('', 'start', 'vladimir'))
      .toThrow(/not configured/i);
  });

  it('treats return query parameters as a notice, not connection state', () => {
    // The notice names the artist only from rows the CRM actually loaded, so a
    // crafted `?artist=` cannot put text on the page or reveal an artist this
    // operator cannot manage.
    const visible = new Map([['vladimir', 'Vladimir'], ['sam', 'Sam']]);
    expect(connectionResultNotice('?calendar=connected&artist=vladimir', 'en', visible))
      .toContain('reloaded from the CRM');
    expect(connectionResultNotice('?calendar=connected&artist=sam', 'en', visible))
      .toContain('Sam');
    expect(connectionResultNotice('?calendar=connected&artist=unknown', 'en', visible)).toBeNull();
    expect(connectionResultNotice('?calendar=connected&artist=kristina', 'en', visible)).toBeNull();
    expect(connectionResultNotice('?calendar=connected&artist=vladimir', 'en')).toBeNull();
    expect(connectionResultNotice('?artist=vladimir', 'ru', visible)).toBeNull();
  });

  it('preserves the Calendar Connections hash route after OAuth returns', () => {
    const returned = new URL(
      'https://vishar-crm-staging.pages.dev/?calendar=connected&artist=vladimir#/integrations/calendar',
    );
    expect(returned.pathname).toBe('/');
    expect(returned.hash).toBe('#/integrations/calendar');
    expect(connectionResultNotice(returned.search, 'en', new Map([['vladimir', 'Vladimir']])))
      .toContain('reloaded from the CRM');
  });

  it('builds a connector URL for any artist slug and refuses a malformed one', () => {
    const origin = 'https://calendar-staging.vishartattoo.com';
    expect(calendarConnectorUrl(origin, 'start', 'sam'))
      .toBe('https://calendar-staging.vishartattoo.com/oauth/google/start/sam');
    expect(calendarConnectorUrl(origin, 'disconnect', 'new-artist-42'))
      .toBe('https://calendar-staging.vishartattoo.com/oauth/google/disconnect/new-artist-42');
    expect(() => calendarConnectorUrl(origin, 'start', '../admin')).toThrow(/unknown/i);
    expect(() => calendarConnectorUrl(origin, 'start', 'Vladimir')).toThrow(/unknown/i);
  });

  it('shows integration navigation only to coarse roles that may hold artist capability', () => {
    expect(can('owner', 'manageIntegrations')).toBe(true);
    expect(can('booking_manager', 'manageIntegrations')).toBe(true);
    expect(can('read_only', 'manageIntegrations')).toBe(false);
    expect(navItemsFor('owner').some((item) => item.path === '/integrations')).toBe(true);
    expect(navItemsFor('read_only').some((item) => item.path === '/integrations')).toBe(false);
  });
});
