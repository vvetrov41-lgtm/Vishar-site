import { describe, expect, it, vi } from 'vitest';
import {
  __testing,
  createAnalytics,
  leadTimeDaysBucket,
  readAnalyticsConfig,
  screenForPath,
  SCREENS,
} from '../lib/product-analytics';

const KEY = 'phc_vqMLhbmGMXvbqL6givoXnKFDRExyn3ewtXHuoqkxaDap';
const HOST = 'eu.i.posthog.com';
const CONFIG = { key: KEY, host: HOST };

function recorder() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response('', { status: 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function sentBody(calls: Array<{ init: RequestInit }>, index = 0) {
  return JSON.parse(String(calls[index].init.body));
}

describe('PostHog configuration', () => {
  it('accepts only an approved ingestion host', () => {
    expect(readAnalyticsConfig({ VITE_POSTHOG_KEY: KEY, VITE_POSTHOG_HOST: 'eu.i.posthog.com' })).toEqual(CONFIG);
    expect(readAnalyticsConfig({ VITE_POSTHOG_KEY: KEY, VITE_POSTHOG_HOST: 'us.i.posthog.com' })?.host).toBe('us.i.posthog.com');
    for (const host of ['evil.example', 'posthog.com', 'eu.i.posthog.com.evil.example', '', 'localhost']) {
      expect(readAnalyticsConfig({ VITE_POSTHOG_KEY: KEY, VITE_POSTHOG_HOST: host })).toBeNull();
    }
  });

  it('rejects anything that is not a publishable project key', () => {
    for (const key of ['', 'phx_abc', 'phc_short', 'sk_live_secret', undefined]) {
      expect(readAnalyticsConfig({ VITE_POSTHOG_KEY: key, VITE_POSTHOG_HOST: HOST })).toBeNull();
    }
  });

  it('stays dormant when unconfigured', async () => {
    const { calls, fetchImpl } = recorder();
    await createAnalytics(null, { fetchImpl }).capture('crm_screen_viewed', { screen: 'dashboard' });
    expect(calls).toHaveLength(0);
  });
});

describe('event allow-list', () => {
  it('sends the four approved events with bounded properties', async () => {
    const { calls, fetchImpl } = recorder();
    const analytics = createAnalytics(CONFIG, { fetchImpl });

    await analytics.capture('crm_screen_viewed', { screen: 'enquiry_detail' });
    await analytics.capture('crm_enquiry_converted', { outcome: 'converted' });
    await analytics.capture('crm_appointment_booked', {
      appointment_kind: 'session', origin: 'crm', lead_time_days_bucket: 14,
    });
    await analytics.capture('crm_conversation_reply_outcome', { channel: 'whatsapp', outcome: 'queued' });

    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(`https://${HOST}/i/v0/e/`);
    expect(sentBody(calls, 0).event).toBe('crm_screen_viewed');
    expect(sentBody(calls, 0).properties.screen).toBe('enquiry_detail');
    expect(sentBody(calls, 2).properties.lead_time_days_bucket).toBe(14);
    expect(sentBody(calls, 3).properties.channel).toBe('whatsapp');
  });

  it('drops any event that is not registered', async () => {
    const { calls, fetchImpl } = recorder();
    const analytics = createAnalytics(CONFIG, { fetchImpl });
    for (const event of ['$pageview', '$autocapture', '$identify', '$set', 'crm_client_exported']) {
      await analytics.capture(event, { screen: 'dashboard' });
    }
    expect(calls).toHaveLength(0);
  });

  it('drops an event whose enum value is not approved', async () => {
    const { calls, fetchImpl } = recorder();
    const analytics = createAnalytics(CONFIG, { fetchImpl });
    await analytics.capture('crm_screen_viewed', { screen: '/enquiries/8f2c-1a9b' });
    await analytics.capture('crm_conversation_reply_outcome', { channel: 'sms', outcome: 'sent' });
    await analytics.capture('crm_appointment_booked', {
      appointment_kind: 'session', origin: 'crm', lead_time_days_bucket: 1_756_900_000,
    });
    expect(calls).toHaveLength(0);
  });

  it('drops incidental identifiers and free text rather than forwarding them', async () => {
    const { calls, fetchImpl } = recorder();
    await createAnalytics(CONFIG, { fetchImpl }).capture('crm_screen_viewed', {
      screen: 'client_detail',
      client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      enquiry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      email: 'client@example.com',
      phone: '+447700900123',
      name: 'A Real Client',
      message: 'can I move my session',
      url: 'https://crm.vishartattoo.com/#/clients/42?tab=notes',
    });

    expect(calls).toHaveLength(1);
    const body = String(calls[0].init.body);
    for (const leak of [
      'cccccccc', 'eeeeeeee', 'client@example.com', '447700900123',
      'A Real Client', 'can I move', 'crm.vishartattoo.com', 'tab=notes',
    ]) {
      expect(body).not.toContain(leak);
    }
    expect(sentBody(calls).properties).toMatchObject({ screen: 'client_detail' });
  });

  it('covers every normalized screen without exposing a route', async () => {
    const { calls, fetchImpl } = recorder();
    const analytics = createAnalytics(CONFIG, { fetchImpl });
    for (const screen of SCREENS) await analytics.capture('crm_screen_viewed', { screen });
    expect(calls).toHaveLength(SCREENS.length);
    for (const call of calls) expect(String(call.init.body)).not.toContain('/');
  });
});

describe('identity and person profiles', () => {
  it('disables person profiles on every event', async () => {
    const { calls, fetchImpl } = recorder();
    await createAnalytics(CONFIG, { fetchImpl }).capture('crm_screen_viewed', { screen: 'inbox' });
    expect(sentBody(calls).properties.$process_person_profile).toBe(false);
  });

  it('uses a fresh distinct ID per event so nothing is joinable', async () => {
    const { calls, fetchImpl } = recorder();
    const analytics = createAnalytics(CONFIG, { fetchImpl });
    for (let i = 0; i < 5; i += 1) await analytics.capture('crm_screen_viewed', { screen: 'dashboard' });
    const ids = calls.map((call) => sentBody([call]).distinct_id);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^anon-[0-9a-f-]{36}$/);
  });

  it('blanks the URL, referrer and IP that PostHog would otherwise infer', async () => {
    const { calls, fetchImpl } = recorder();
    await createAnalytics(CONFIG, { fetchImpl }).capture('crm_screen_viewed', { screen: 'payments' });
    const { properties } = sentBody(calls);
    for (const key of ['$current_url', '$referrer', '$referring_domain', '$ip']) {
      expect(properties[key]).toBeNull();
    }
  });

  it('sends no credentials and follows no redirect', async () => {
    const { calls, fetchImpl } = recorder();
    await createAnalytics(CONFIG, { fetchImpl }).capture('crm_screen_viewed', { screen: 'settings' });
    expect(calls[0].init.credentials).toBe('omit');
    expect(calls[0].init.redirect).toBe('manual');
  });
});

describe('fail-open transport', () => {
  it('swallows a rejected capture', async () => {
    const analytics = createAnalytics(CONFIG, {
      fetchImpl: (async () => { throw new Error('blocked by an ad blocker'); }) as unknown as typeof fetch,
    });
    await expect(analytics.capture('crm_screen_viewed', { screen: 'dashboard' })).resolves.toBeUndefined();
  });

  it('abandons a hung ingestion endpoint', async () => {
    const analytics = createAnalytics(CONFIG, {
      timeoutMs: 10,
      fetchImpl: ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch,
    });
    await expect(analytics.capture('crm_screen_viewed', { screen: 'dashboard' })).resolves.toBeUndefined();
  });
});

describe('registry shape', () => {
  it('registers exactly the four approved events', () => {
    expect(Object.keys(__testing.EVENT_REGISTRY).sort()).toEqual([
      'crm_appointment_booked',
      'crm_conversation_reply_outcome',
      'crm_enquiry_converted',
      'crm_screen_viewed',
    ]);
  });

  it('allows no free-text property anywhere in the registry', () => {
    for (const schema of Object.values(__testing.EVENT_REGISTRY)) {
      for (const rule of Object.values(schema)) {
        expect(rule === 'small_int' || Array.isArray(rule)).toBe(true);
      }
    }
  });
});

describe('route and lead-time normalization', () => {
  it('maps a route to a screen without carrying any identifier through', () => {
    expect(screenForPath('/')).toBe('dashboard');
    expect(screenForPath('/enquiries')).toBe('enquiries');
    expect(screenForPath('/enquiries/8f2c1a9b-0000-4000-8000-000000000000')).toBe('enquiry_detail');
    expect(screenForPath('/clients/42')).toBe('client_detail');
    expect(screenForPath('/inbox')).toBe('inbox');
    expect(screenForPath('/inbox/abc')).toBe('conversation_detail');
    expect(screenForPath('/inbox/email/thread-key')).toBe('conversation_detail');
    expect(screenForPath('/payments?tab=deposits')).toBe('payments');
    expect(screenForPath('/something-new/99')).toBe('other');
    for (const path of ['/clients/42', '/enquiries/8f2c1a9b', '/inbox/email/k']) {
      expect(SCREENS).toContain(screenForPath(path));
    }
  });

  it('buckets lead time into safe whole days', () => {
    const now = new Date('2026-09-03T00:00:00Z');
    expect(leadTimeDaysBucket('2026-09-17T00:00:00Z', now)).toBe(14);
    expect(leadTimeDaysBucket('2026-09-03T06:00:00Z', now)).toBe(0);
    expect(leadTimeDaysBucket('2026-01-01T00:00:00Z', now)).toBe(0);
    expect(leadTimeDaysBucket('2030-01-01T00:00:00Z', now)).toBe(365);
    expect(leadTimeDaysBucket('not-a-date', now)).toBe(0);
  });
});
