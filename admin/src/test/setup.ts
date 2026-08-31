import '@testing-library/jest-dom/vitest';
import { beforeEach, vi } from 'vitest';

// No test may reach the network, and none should wait to find that out.
//
// The CRM asks the Gmail gateway for live mailbox history whenever an email
// conversation is opened. Left unstubbed, that call goes to whatever jsdom's
// fetch does with an unreachable host - which is slow enough to race a
// `findBy*` timeout and make neighbouring assertions fail intermittently.
//
// Failing immediately is both faster and more honest: a test that wants live
// Gmail stubs `fetch` itself, and every other test sees the gateway as
// unavailable, which is exactly the degraded path those screens must survive.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('network disabled in tests');
  }));
});
