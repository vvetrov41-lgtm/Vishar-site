import type { LiveGmailClientHistory, LiveGmailOptions } from './email-api';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

type Loader = (clientId: string, options?: LiveGmailOptions) => Promise<LiveGmailClientHistory>;

interface CacheEntry {
  expiresAt: number;
  value: LiveGmailClientHistory;
}

/**
 * Small browser-memory cache for client-scoped Gmail content.
 *
 * Metadata lists never use this cache: they come from the CRM snapshot. Message
 * bodies enter memory only after an operator opens one client. `force` bypasses
 * the cache for the explicit Refresh action without changing server boundaries.
 */
export function createGmailClientHistoryCache(
  loader: Loader,
  { ttlMs = DEFAULT_TTL_MS, now = () => Date.now() }: { ttlMs?: number; now?: () => number } = {},
) {
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<LiveGmailClientHistory>>();

  return {
    async load(
      clientId: string,
      options: LiveGmailOptions & { force?: boolean } = {},
    ): Promise<LiveGmailClientHistory> {
      const { force = false, ...liveOptions } = options;
      const current = entries.get(clientId);
      if (!force && current && current.expiresAt > now()) return current.value;
      if (!force) {
        const inflight = pending.get(clientId);
        if (inflight) return inflight;
      }

      const request = loader(clientId, liveOptions).then((value) => {
        entries.set(clientId, { value, expiresAt: now() + ttlMs });
        return value;
      });
      pending.set(clientId, request);
      try {
        return await request;
      } finally {
        if (pending.get(clientId) === request) pending.delete(clientId);
      }
    },

    clear(clientId?: string): void {
      if (clientId) entries.delete(clientId);
      else entries.clear();
    },
  };
}

export const __testing = Object.freeze({ DEFAULT_TTL_MS });
