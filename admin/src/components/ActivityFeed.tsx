import { useEffect, useRef, useState } from 'react';
import { EmptyState } from './StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { operationalLabel } from '../lib/operational-labels';
import { useApi } from '../lib/session';
import type { ActivityEntry } from '../lib/types';

export interface ActivityFeedFilter {
  enquiryId?: string;
  clientId?: string;
  projectId?: string;
  sessionId?: string;
  eventType?: string;
  artistId?: string;
}

export function ActivityFeed({
  filter = {},
  emptyTitle,
  pageSize = 20,
  initiallyCollapsed = false,
}: {
  filter?: ActivityFeedFilter;
  emptyTitle?: string;
  pageSize?: number;
  initiallyCollapsed?: boolean;
}) {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(!initiallyCollapsed);
  const [reloadKey, setReloadKey] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const safePageSize = Math.max(1, Math.min(Math.floor(pageSize), 50));
  const filterKey = [
    filter.enquiryId ?? '',
    filter.clientId ?? '',
    filter.projectId ?? '',
    filter.sessionId ?? '',
    filter.eventType ?? '',
    filter.artistId ?? '',
  ].join('|');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setEntries([]);
    setNextOffset(0);
    setHasMore(false);
    setExpanded(!initiallyCollapsed);

    void api.listActivity({
      ...filter,
      limit: safePageSize,
      offset: 0,
    }).then((page) => {
      if (cancelled) return;
      setEntries(page);
      setNextOffset(page.length);
      setHasMore(page.length === safePageSize);
    }).catch(() => {
      if (!cancelled) setError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
    // filterKey is the stable identity of the primitive filter fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filterKey, safePageSize, reloadKey, initiallyCollapsed]);

  async function loadMore() {
    if (loading || loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(false);
    try {
      const page = await api.listActivity({
        ...filter,
        limit: safePageSize,
        offset: nextOffset,
      });
      setEntries((current) => {
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...page.filter((entry) => !seen.has(entry.id))];
      });
      setNextOffset((current) => current + page.length);
      setHasMore(page.length === safePageSize);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!expanded || !hasMore || loading || loadingMore) return;
    if (typeof window === 'undefined' || !window.matchMedia?.('(max-width: 639px)').matches) return;
    if (typeof IntersectionObserver === 'undefined' || !sentinelRef.current) return;

    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) void loadMore();
    }, { rootMargin: '180px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  });

  if (loading) {
    return <p className="meta activity-feed-state">{t('activity.loading')}</p>;
  }

  if (entries.length === 0 && !error) {
    return <EmptyState compact title={emptyTitle ?? t('activity.noMatch')} />;
  }

  const visibleEntries = initiallyCollapsed && !expanded ? entries.slice(0, 1) : entries;

  return (
    <div className="activity-feed">
      {visibleEntries.length > 0 ? (
        <ul className="timeline">
          {visibleEntries.map((entry) => (
            <li key={entry.id}>
              <div title={entry.event_type}>
                {operationalLabel(language, 'event', entry.event_type)}
              </div>
              <div className="when">
                {formatDateTime(entry.occurred_at, language)} · {label('actor', entry.actor_kind)}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <div className="activity-feed-error" role="alert">
          <span>{t('activity.loadFailed')}</span>
          <button
            type="button"
            className="badge"
            onClick={() => entries.length > 0 ? void loadMore() : setReloadKey((value) => value + 1)}
          >
            {t('activity.retry')}
          </button>
        </div>
      ) : null}

      {initiallyCollapsed && !expanded && (entries.length > 1 || hasMore) ? (
        <div className="actions">
          <button type="button" onClick={() => setExpanded(true)}>
            {t('activity.expand')}
          </button>
        </div>
      ) : expanded && hasMore ? (
        <>
          <div className="actions">
            <button type="button" disabled={loadingMore} onClick={() => { void loadMore(); }}>
              {loadingMore ? t('activity.loadingMore') : t('activity.loadMore')}
            </button>
          </div>
          <div ref={sentinelRef} className="activity-feed-sentinel" aria-hidden="true" />
        </>
      ) : null}
    </div>
  );
}
