import { afterEach, describe, expect, it } from 'vitest';
import { __testing } from '../lib/router';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('router direct OAuth consent entry', () => {
  it('preserves ordinary hash routing', () => {
    window.history.replaceState(null, '', '/#/appointments');
    expect(__testing.currentPath()).toBe('/appointments');
  });

  it('routes the Supabase OAuth authorization pathname to the consent screen', () => {
    window.history.replaceState(
      null,
      '',
      '/oauth/consent?authorization_id=synthetic-authorization-id',
    );
    expect(__testing.currentPath()).toBe('/oauth/consent');
  });

  it('accepts a trailing slash only for the same OAuth consent entry point', () => {
    window.history.replaceState(
      null,
      '',
      '/oauth/consent/?authorization_id=synthetic-authorization-id',
    );
    expect(__testing.currentPath()).toBe('/oauth/consent');
  });

  it('does not convert arbitrary direct CRM paths into non-hash routes', () => {
    window.history.replaceState(null, '', '/appointments');
    expect(__testing.currentPath()).toBe('/');
  });
});
