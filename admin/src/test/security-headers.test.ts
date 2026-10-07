import { describe, expect, it } from 'vitest';
import headers from '../../public/_headers?raw';
import { __testing } from '../lib/product-analytics';

describe('CRM Pages security headers', () => {
  it('allows only the approved analytics capture paths, not arbitrary PostHog access', () => {
    const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy:'))!;
    const connectSources = csp.match(/connect-src ([^;]+)/)![1].split(/\s+/);
    const analyticsSources = connectSources.filter((source) => source.includes('posthog'));
    expect(analyticsSources.sort()).toEqual(
      __testing.APPROVED_HOSTS.map((host) => `https://${host}/i/v0/e/`).sort(),
    );
    expect(csp).toContain("script-src 'self' https://connect.facebook.net;");
    expect(csp).toContain("frame-ancestors 'none';");
    expect(csp).not.toContain('https://*.posthog.com');
  });
  it('allows the production Gmail operator origin in connect-src', () => {
    const csp = headers
      .split('\n')
      .find((line) => line.includes('Content-Security-Policy:'));

    expect(csp).toBeDefined();
    const connectSrc = csp?.match(/connect-src ([^;]+)/)?.[1];
    expect(connectSrc).toContain('https://gmail.vishartattoo.com');
  });
});
