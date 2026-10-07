import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTodayCache, useTodayResource } from '../lib/today-resource';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { clearTodayCache(); vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-09-01') }); });
afterEach(() => vi.useRealTimers());

describe('Today snapshots', () => {
  it('deduplicates StrictMode and concurrent consumers', async () => {
    const api = {}; const response = deferred<string>(); const loader = vi.fn(() => response.promise);
    const first = renderHook(() => useTodayResource(api, 'owner:artist-a', 'pulse', loader), { wrapper: StrictMode });
    const second = renderHook(() => useTodayResource(api, 'owner:artist-a', 'pulse', loader));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await act(async () => response.resolve('authorized snapshot'));
    expect(first.result.current.data).toBe('authorized snapshot');
    expect(second.result.current.data).toBe('authorized snapshot');
  });

  it('keeps a stale snapshot visible during refresh and after refresh failure', async () => {
    const api = {}; const loader = vi.fn().mockResolvedValueOnce('previous').mockRejectedValueOnce(new Error('unavailable'));
    const first = renderHook(() => useTodayResource(api, 'owner:a', 'pulse', loader, 1000));
    await waitFor(() => expect(first.result.current.data).toBe('previous'));
    first.unmount(); vi.setSystemTime(new Date('2026-09-01T00:00:02Z'));
    const next = renderHook(() => useTodayResource(api, 'owner:a', 'pulse', loader, 1000));
    expect(next.result.current.data).toBe('previous');
    await waitFor(() => expect(next.result.current.error).toBe('unavailable'));
    expect(next.result.current.data).toBe('previous');
  });

  it('does not reuse another scope or an old authenticated API snapshot', async () => {
    const api = {}; const pending = deferred<string>();
    const loader = vi.fn().mockResolvedValueOnce('artist-a').mockImplementationOnce(() => pending.promise);
    const hook = renderHook(({ scope }) => useTodayResource(api, scope, 'pulse', loader), { initialProps: { scope: 'owner:a' } });
    await waitFor(() => expect(hook.result.current.data).toBe('artist-a'));
    hook.rerender({ scope: 'owner:b' });
    expect(hook.result.current.data).toBeNull();
    await act(async () => pending.resolve('artist-b'));
    expect(hook.result.current.data).toBe('artist-b');
    hook.unmount(); clearTodayCache();
    const newAuth = deferred<string>();
    const next = renderHook(() => useTodayResource(api, 'owner:b', 'pulse', () => newAuth.promise));
    expect(next.result.current.data).toBeNull();
    await act(async () => newAuth.resolve('new auth'));
  });

  it('expires snapshots on a later open, without erasing a continuously mounted page', async () => {
    const api = {}; const response = deferred<string>(); const loader = vi.fn().mockResolvedValueOnce('previous').mockImplementationOnce(() => response.promise);
    const first = renderHook(() => useTodayResource(api, 'owner:a', 'pulse', loader));
    await waitFor(() => expect(first.result.current.data).toBe('previous'));
    vi.setSystemTime(new Date('2026-09-01T00:03:00Z'));
    first.rerender(); expect(first.result.current.data).toBe('previous');
    first.unmount();
    const next = renderHook(() => useTodayResource(api, 'owner:a', 'pulse', loader));
    expect(next.result.current.data).toBeNull();
    await act(async () => response.resolve('fresh'));
    expect(next.result.current.data).toBe('fresh');
  });
});
