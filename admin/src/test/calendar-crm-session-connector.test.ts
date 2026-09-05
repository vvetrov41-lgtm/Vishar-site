import { describe, expect, it, vi } from 'vitest';
import {
  disconnectCalendarConnection,
  startCalendarConnection,
} from '../lib/calendar-connections-api';

const ORIGIN = 'https://calendar.vishartattoo.com';
const TOKEN = 'crm-session-token';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Calendar self-service connector transport', () => {
  it('starts OAuth with the existing CRM bearer and returns only a Google authorization URL', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.mode).toBe('cors');
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(init?.body).toBeUndefined();
      return jsonResponse({
        ok: true,
        authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque&client_id=x',
      });
    });

    await expect(startCalendarConnection(ORIGIN, 'sam', TOKEN, fetchImpl as typeof fetch))
      .resolves.toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ORIGIN}/oauth/google/start/sam`,
      expect.any(Object),
    );
  });

  it('never follows a connector redirect or accepts a non-Google authorization target', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true,
      authorization_url: 'https://evil.example/oauth?state=opaque',
    }));

    await expect(startCalendarConnection(ORIGIN, 'sam', TOKEN, fetchImpl as typeof fetch))
      .rejects.toThrow();
  });

  it('disconnects only through an authenticated explicit POST confirmation', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe('POST');
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({ confirm: 'disconnect' });
      return jsonResponse({ ok: true, artist: 'sam', connected: false, revoked: true });
    });

    await expect(disconnectCalendarConnection(ORIGIN, 'sam', TOKEN, fetchImpl as typeof fetch))
      .resolves.toBeUndefined();
  });

  it('fails before the network when there is no live CRM session', async () => {
    const fetchImpl = vi.fn();
    await expect(startCalendarConnection(ORIGIN, 'sam', '', fetchImpl as typeof fetch))
      .rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not trust arbitrary connector errors outside the safe error-code shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, code: '<script>' }, 403));
    await expect(startCalendarConnection(ORIGIN, 'sam', TOKEN, fetchImpl as typeof fetch))
      .rejects.toThrow();
  });
});
