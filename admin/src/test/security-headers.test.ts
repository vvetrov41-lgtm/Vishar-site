import { describe, expect, it } from 'vitest';
import headers from '../../public/_headers?raw';

describe('CRM Pages security headers', () => {
  it('allows the production Gmail operator origin in connect-src', () => {
    const csp = headers
      .split('\n')
      .find((line) => line.includes('Content-Security-Policy:'));

    expect(csp).toBeDefined();
    const connectSrc = csp?.match(/connect-src ([^;]+)/)?.[1];
    expect(connectSrc).toContain('https://gmail.vishartattoo.com');
  });
});
