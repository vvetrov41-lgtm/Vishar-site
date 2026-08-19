// Instagram connection management.
//
// Each artist connects their own Instagram professional account. There is no
// shared connection and no fallback: connecting Vladimir never touches
// Kristina's route, and an operator only sees the artists whose integrations
// they may manage.
//
// The CRM never builds the Meta authorization URL itself. It asks the
// connector, which asks the database whether this operator may connect this
// artist and derives the routing selector server-side.

import { useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { useSession } from '../lib/session';
import type { Artist } from '../lib/types';
import type {
  InstagramConnectionStatus,
  InstagramIntegrationMetadata,
} from '../lib/instagram-connections-api';

const COPY = {
  en: {
    title: 'Instagram',
    intro:
      'Each artist connects their own Instagram professional account. Messages arrive in Communications, and replies are sent from that artist account only.',
    notConfigured:
      'The Instagram connector is not configured in this CRM build, so connections cannot be managed here yet.',
    loading: 'Loading Instagram connections…',
    noArtists: 'No artists to manage',
    noArtistsHint: 'You need integration rights on an artist to connect Instagram for them.',
    connect: 'Connect Instagram',
    reconnect: 'Reconnect',
    disconnect: 'Disconnect',
    connected: 'Connected',
    notConnected: 'Not connected',
    needsReconnect: 'Needs reconnecting',
    tokenExpires: 'Access expires',
    account: 'Account',
    updated: 'Updated',
    checking: 'Checking…',
    reviewNotice:
      'Instagram messaging requires the Meta app to have been granted Advanced Access for message permissions. Until then only accounts with a role on the Meta app can connect.',
  },
  ru: {
    title: 'Instagram',
    intro:
      'Каждый мастер подключает свой профессиональный аккаунт Instagram. Сообщения приходят в раздел «Сообщения», а ответы уходят только из аккаунта этого мастера.',
    notConfigured:
      'Коннектор Instagram не настроен в этой сборке CRM, поэтому подключения пока недоступны.',
    loading: 'Загружаем подключения Instagram…',
    noArtists: 'Нет мастеров для управления',
    noArtistsHint: 'Нужны права на интеграции мастера, чтобы подключить ему Instagram.',
    connect: 'Подключить Instagram',
    reconnect: 'Переподключить',
    disconnect: 'Отключить',
    connected: 'Подключено',
    notConnected: 'Не подключено',
    needsReconnect: 'Требуется переподключение',
    tokenExpires: 'Доступ истекает',
    account: 'Аккаунт',
    updated: 'Обновлено',
    checking: 'Проверяем…',
    reviewNotice:
      'Для обмена сообщениями приложение Meta должно получить Advanced Access к разрешениям на сообщения. До этого подключиться могут только аккаунты с ролью в приложении Meta.',
  },
} as const;

interface ConnectionsData {
  artists: Artist[];
  integrations: InstagramIntegrationMetadata[];
  statuses: Record<string, InstagramConnectionStatus | null>;
}

function canManageArtist(
  role: string | null | undefined,
  artistId: string,
  memberships: ReturnType<typeof useSession>['memberships'],
): boolean {
  if (role === 'owner') return true;
  return memberships.some(
    (membership) => membership.artist_id === artistId
      && membership.is_active
      && membership.can_manage_integrations,
  );
}

export function InstagramConnectionsPage() {
  const { api, profile, memberships } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [busyArtistId, setBusyArtistId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const configured = Boolean(api?.instagramConnectorConfigured);

  const { data, loading, error, reload } = useAsync<ConnectionsData>(async () => {
    if (!api) throw new Error('CRM API unavailable.');
    const [allArtists, integrations] = await Promise.all([
      api.listAccessibleArtists(),
      api.listInstagramIntegrations(),
    ]);
    const artists = allArtists.filter(
      (artist) => artist.is_active && canManageArtist(profile?.role, artist.id, memberships),
    );

    const statuses: Record<string, InstagramConnectionStatus | null> = {};
    if (configured) {
      await Promise.all(artists.map(async (artist) => {
        try {
          statuses[artist.id] = await api.instagramConnectionStatus(artist.id);
        } catch {
          // The connector may be deployed but not yet enabled. The page still
          // renders the database view of the integration.
          statuses[artist.id] = null;
        }
      }));
    }
    return { artists, integrations, statuses };
  }, [api, configured, memberships, profile?.role]);

  async function run(artistId: string, action: () => Promise<unknown>) {
    setBusyArtistId(artistId);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusyArtistId(null);
    }
  }

  async function connect(artistId: string) {
    if (!api) return;
    const started = await api.startInstagramConnection(artistId);
    // Meta requires a full page navigation for the authorization screen.
    window.location.assign(started.authorize_url);
  }

  return (
    <Section title={copy.title}>
      <p className="notice">{copy.intro}</p>
      <p className="notice">{copy.reviewNotice}</p>
      {!configured ? <p className="notice warn" role="status">{copy.notConfigured}</p> : null}
      {actionError ? <p className="notice warn" role="alert">{actionError}</p> : null}

      {loading ? <LoadingState label={copy.loading} /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}

      {!loading && !error && data && data.artists.length === 0 ? (
        <EmptyState title={copy.noArtists} hint={copy.noArtistsHint} />
      ) : null}

      {!loading && !error && data && data.artists.length > 0 ? (
        <div className="list">
          {data.artists.map((artist) => {
            const integration = data.integrations.find(
              (row) => row.artist_id === artist.id && row.is_enabled,
            );
            const status = data.statuses[artist.id] ?? null;
            const connected = status ? status.connected : Boolean(integration);
            const needsReconnect = Boolean(status?.needs_reconnect);
            const busy = busyArtistId === artist.id;

            return (
              <div key={artist.id} className="row">
                <div className="title">{artist.display_name}</div>
                <div className="meta">
                  <span className={connected ? 'badge ok' : 'badge'}>
                    {needsReconnect
                      ? copy.needsReconnect
                      : connected ? copy.connected : copy.notConnected}
                  </span>
                  {integration?.external_account_label ? (
                    <> · {copy.account}: {integration.external_account_label}</>
                  ) : null}
                </div>
                {status?.token_expires_at ? (
                  <div className="meta">
                    {copy.tokenExpires}: {formatDateTime(status.token_expires_at, language)}
                  </div>
                ) : null}
                {integration ? (
                  <div className="meta">
                    {copy.updated}: {formatDateTime(integration.updated_at, language)}
                  </div>
                ) : null}

                <div className="actions">
                  <button
                    type="button"
                    className={connected ? undefined : 'primary'}
                    disabled={!configured || busy}
                    onClick={() => { void run(artist.id, () => connect(artist.id)); }}
                  >
                    {busy ? copy.checking : connected ? copy.reconnect : copy.connect}
                  </button>
                  {connected ? (
                    <button
                      type="button"
                      disabled={!configured || busy}
                      onClick={() => {
                        void run(artist.id, () => api!.disconnectInstagram(artist.id));
                      }}
                    >
                      {copy.disconnect}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </Section>
  );
}
