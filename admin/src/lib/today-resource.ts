import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { todayTiming, type TodayTimingStage } from './today-performance';

interface Snapshot<T> { data: T | null; error: string | null; loading: boolean }
interface Entry<T> {
  snapshot: Snapshot<T>; updatedAt: number; pending: Promise<void> | null;
  listeners: Set<() => void>; version: number;
}
let caches = new WeakMap<object, Map<string, Entry<unknown>>>();
const EMPTY: Snapshot<never> = { data: null, error: null, loading: true };
const MAX_STALE_MS = 120_000;

/** Auth changes discard every snapshot. Nothing is persisted or shared across tabs. */
export function clearTodayCache() { caches = new WeakMap(); }

export function useTodayResource<T>(
  api: object, scope: string | null, resource: string, loader: () => Promise<T>, freshMs = 30_000,
) {
  let cache = caches.get(api);
  if (!cache) { cache = new Map(); caches.set(api, cache); }
  const key = `${scope}:${resource}`;
  let entry = cache.get(key) as Entry<T> | undefined;
  if (!entry) {
    entry = { snapshot: EMPTY, updatedAt: 0, pending: null, listeners: new Set(), version: 0 };
    cache.set(key, entry as Entry<unknown>);
    // Keep the small number of currently visible scopes; never an unbounded archive.
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  const current = entry;
  // Expiry is an entry/navigation policy. A mounted page must not erase its
  // content merely because an unrelated React update happens two minutes later.
  const openedAt = useMemo(() => Date.now(), [current]);
  const notify = () => current.listeners.forEach((listener) => listener());
  const load = (force = false) => {
    if (scope === null || current.pending && !force) return;
    if (!force && current.updatedAt && Date.now() - current.updatedAt < freshMs) return;
    const version = ++current.version;
    current.snapshot = { ...current.snapshot, loading: true, error: null };
    notify();
    const start = performance.now();
    todayTiming(`${resource}_start` as TodayTimingStage, 0);
    current.pending = Promise.resolve().then(loader).then((data) => {
      if (version !== current.version) return;
      current.updatedAt = Date.now();
      current.snapshot = { data, error: null, loading: false };
    }).catch((cause: unknown) => {
      if (version !== current.version) return;
      current.snapshot = { ...current.snapshot, error: cause instanceof Error ? cause.message : 'Could not load that.', loading: false };
    }).finally(() => {
      todayTiming((resource === 'navigation' ? 'navigation_data' : resource) as TodayTimingStage, performance.now() - start);
      if (version !== current.version) return;
      current.pending = null;
      notify();
    });
  };
  const snapshot = useSyncExternalStore(
    (listener) => { current.listeners.add(listener); return () => { current.listeners.delete(listener); }; },
    () => scope === null || current.updatedAt && openedAt - current.updatedAt > MAX_STALE_MS ? EMPTY : current.snapshot,
  );
  useEffect(() => {
    if (current.updatedAt && Date.now() - current.updatedAt > MAX_STALE_MS) {
      current.snapshot = EMPTY; current.updatedAt = 0;
      notify();
    }
    load();
    // Scope and API identity are the ownership boundary, not the inline loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope, resource, current]);
  return { ...snapshot, reload: () => load(true) };
}
