import { TelegramConnectionCard } from '../components/TelegramConnectionCard';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { visibleIntegrationArtistIds } from '../lib/integration-visibility';
import { useApi, useSession } from '../lib/session';

/**
 * Artist-bound Telegram destinations.
 *
 * New enquiry notifications are routed to the artist destination, not to the
 * signed-in person's personal Telegram. The Notifications page is the primary
 * UI for both settings now; this component stays reusable so the old
 * /integrations/telegram deep link can remain a safe compatibility route
 * without duplicating personal settings.
 */
export function ArtistTelegramNotifications() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { language } = useLanguage();

  const state = useAsync(async () => {
    const [info, destinations, artists] = await Promise.all([
      api.getTelegramConnectorInfo(),
      api.listTelegramDestinations(),
      api.listAccessibleArtists(),
    ]);
    const visibleArtistIds = visibleIntegrationArtistIds(profile, artists, memberships);
    return {
      info,
      // Database permissions stay authoritative; this only narrows what the
      // page offers to the artists whose integrations this profile may manage.
      artistDestinations: destinations.filter(
        (destination) => destination.destination_kind === 'artist'
          && Boolean(destination.artist_id && visibleArtistIds.has(destination.artist_id)),
      ),
    };
  }, [api, memberships, profile]);

  return (
    <Section title={language === 'ru' ? 'Telegram мастеров' : 'Artist Telegram'}>
      <p className="notice">
        {language === 'ru'
          ? 'Уведомления о новых заявках приходят в этот Telegram, а не в личный.'
          : 'New enquiry notifications are delivered to this Telegram, not to your personal one.'}
      </p>
      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error ? (
        state.data && state.data.artistDestinations.length > 0 ? (
          <div className="stack">
            {state.data.artistDestinations.map((destination) => (
              <TelegramConnectionCard
                key={destination.artist_id ?? destination.target_label}
                destination={destination}
                botUsername={state.data?.info.bot_username ?? null}
                onChanged={state.reload}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title={language === 'ru' ? 'Нет доступных мастеров' : 'No manageable artists'}
            hint={language === 'ru'
              ? 'Здесь появляются только мастера, для которых у вас есть право управлять интеграциями.'
              : 'Only artists whose integrations you may manage appear here.'}
          />
        )
      ) : null}
    </Section>
  );
}

export function TelegramConnectionsPage() {
  return (
    <div className="stack">
      <ArtistTelegramNotifications />
    </div>
  );
}
