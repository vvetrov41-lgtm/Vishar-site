import { describe, expect, it } from 'vitest';
import { routePathFromLocation } from '../lib/router';

describe('CRM route selection', () => {
  it('routes the exact Supabase OAuth consent pathname to the consent page', () => {
    expect(routePathFromLocation('/oauth/consent', '')).toBe('/oauth/consent');
  });

  it('keeps ordinary CRM navigation hash-based', () => {
    expect(routePathFromLocation('/', '#/enquiries')).toBe('/enquiries');
    expect(routePathFromLocation('/', '')).toBe('/');
  });

  it('does not widen arbitrary pathnames into CRM routes', () => {
    expect(routePathFromLocation('/oauth/consent-extra', '')).toBe('/');
    expect(routePathFromLocation('/admin', '')).toBe('/');
  });

  it('gives the exact OAuth consent pathname precedence over a stale hash', () => {
    expect(routePathFromLocation('/oauth/consent', '#/payments')).toBe('/oauth/consent');
  });
});
