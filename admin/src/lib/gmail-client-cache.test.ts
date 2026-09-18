import { describe, expect, it, vi } from 'vitest';
import { createGmailClientHistoryCache, __testing } from './gmail-client-cache';
import type { LiveGmailClientHistory } from './email-api';

function history(clientId: string, subject: string): LiveGmailClientHistory {
  return {
    client_id: clientId,
    threads: [{ subject, message_count: 0, messages: [], untrusted_content: true }],
    untrusted_content: true,
  };
}

describe('gmail client history cache', () => {
  it('keeps client content for five minutes and reloads after expiry', async () => {
    let now = 1_000;
    const loader = vi.fn(async (clientId: string) => history(clientId, `call-${loader.mock.calls.length}`));
    const cache = createGmailClientHistoryCache(loader, { now: () => now });

    const first = await cache.load('11111111-1111-4111-8111-111111111111');
    now += __testing.DEFAULT_TTL_MS - 1;
    const cached = await cache.load('11111111-1111-4111-8111-111111111111');
    expect(cached).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);

    now += 2;
    await cache.load('11111111-1111-4111-8111-111111111111');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent reads for the same client', async () => {
    let resolve!: (value: LiveGmailClientHistory) => void;
    const loader = vi.fn(() => new Promise<LiveGmailClientHistory>((done) => { resolve = done; }));
    const cache = createGmailClientHistoryCache(loader);
    const clientId = '22222222-2222-4222-8222-222222222222';

    const left = cache.load(clientId);
    const right = cache.load(clientId);
    expect(loader).toHaveBeenCalledTimes(1);
    resolve(history(clientId, 'same request'));
    await expect(left).resolves.toEqual(await right);
  });

  it('force bypasses a warm cache and forwards live read options', async () => {
    const loader = vi.fn(async (clientId: string) => history(clientId, `call-${loader.mock.calls.length}`));
    const cache = createGmailClientHistoryCache(loader);
    const clientId = '33333333-3333-4333-8333-333333333333';

    await cache.load(clientId, { threadLimit: 2, messageLimit: 5 });
    await cache.load(clientId, { force: true, threadLimit: 3, messageLimit: 7 });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith(clientId, { threadLimit: 3, messageLimit: 7 });
  });

  it('does not share content between clients', async () => {
    const loader = vi.fn(async (clientId: string) => history(clientId, clientId));
    const cache = createGmailClientHistoryCache(loader);

    const a = await cache.load('44444444-4444-4444-8444-444444444444');
    const b = await cache.load('55555555-5555-4555-8555-555555555555');
    expect(a.client_id).not.toBe(b.client_id);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
