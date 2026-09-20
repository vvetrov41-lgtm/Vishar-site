import { useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useArtistScope } from '../lib/artist-scope';
import { can } from '../lib/permissions';
import {
  followUpHref,
  groupFollowUps,
  type FollowUpGroupKey,
} from '../lib/follow-up-groups';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import type { FollowUp } from '../lib/types';

interface FollowUpsData {
  followUps: FollowUp[];
  clientNames: Map<string, string>;
}

const GROUP_KEYS: FollowUpGroupKey[] = [
  'overdue',
  'today',
  'tomorrow',
  'this_week',
  'later',
  'completed',
];

const GROUP_LABELS: Record<FollowUpGroupKey, string> = {
  overdue: 'followUps.overdue',
  today: 'followUps.today',
  tomorrow: 'followUps.tomorrow',
  this_week: 'followUps.thisWeek',
  later: 'followUps.later',
  completed: 'followUps.completed',
};

export function FollowUpsPage() {
  const api = useApi();
  const { profile } = useSession();
  const { selectedArtistId, artists } = useArtistScope();
  const { t, label, language } = useLanguage();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mayComplete = can(profile?.role, 'manageFollowUps');

  const { data, loading, error, reload } = useAsync<FollowUpsData>(async () => {
    const artistId = selectedArtistId ?? undefined;
    const [open, completed] = await Promise.all([
      api.listFollowUps({ artistId, statuses: ['open'], dueDescending: false, limit: 100 }),
      api.listFollowUps({ artistId, statuses: ['done', 'cancelled'], dueDescending: true, limit: 25 }),
    ]);
    const followUps = [...open, ...completed];
    const clients = await api.listClientsByIds(
      followUps.map((followUp) => followUp.client_id ?? '').filter(Boolean)
    );
    return {
      followUps,
      clientNames: new Map(clients.map((client) => [client.id, client.full_name])),
    };
  }, [api, selectedArtistId]);

  async function complete(followUp: FollowUp) {
    if (!mayComplete || busyId) return;
    setBusyId(followUp.id);
    setActionError(null);
    try {
      await api.completeFollowUp(followUp.id);
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('followUps.completeFailed'));
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !data) return <LoadingState label={t('followUps.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t('followUps.empty')} />;

  const groups = groupFollowUps(
    data.followUps,
    new Date(),
    Object.fromEntries(artists.map((artist) => [artist.id, artist.timezone]))
  );
  const hasRows = GROUP_KEYS.some((key) => groups[key].length > 0);

  if (!hasRows) {
    return <EmptyState title={t('followUps.empty')} hint={t('followUps.emptyHint')} />;
  }

  return (
    <>
      {actionError ? <p className="notice warn" role="alert">{actionError}</p> : null}
      {GROUP_KEYS.map((key) => {
        const rows = groups[key];
        if (rows.length === 0) return null;
        return (
          <Section key={key} title={`${t(GROUP_LABELS[key])} · ${rows.length}`}>
            <div className="list">
              {rows.map((followUp) => {
                const clientName = followUp.client_id
                  ? data.clientNames.get(followUp.client_id) ?? null
                  : null;
                return (
                  <div className="row follow-up-workspace-row" key={followUp.id}>
                    <Link to={followUpHref(followUp)} className="follow-up-workspace-main">
                      <div className="title">{clientName ?? followUp.subject}</div>
                      <div className="meta">
                        {clientName ? <><span>{followUp.subject}</span>{' · '}</> : null}
                        <span className="badge">{label('followUpStatus', followUp.status)}</span>{' '}
                        {formatDateTime(followUp.due_at, language)}
                      </div>
                      {followUp.details ? <div className="meta">{followUp.details}</div> : null}
                    </Link>
                    {followUp.status === 'open' && mayComplete ? (
                      <button
                        type="button"
                        className="badge follow-up-done"
                        disabled={busyId === followUp.id}
                        onClick={() => { void complete(followUp); }}
                      >
                        {busyId === followUp.id ? t('followUps.completing') : t('followUps.done')}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Section>
        );
      })}
    </>
  );
}
