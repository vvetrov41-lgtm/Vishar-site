import { PersonalTelegramNotifications } from '../components/PersonalTelegramNotifications';
import { TelegramConnectionCard } from '../components/TelegramConnectionCard';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { visibleIntegrationArtistIds } from '../lib/integration-visibility';
import { useApi, useSession } from '../lib/session';

/**
 * Telegram integration surface.
 *
 * Personal delivery is the shared component the Notifications page also renders,
 * so the two pages cannot drift. The artist section below is separate on purpose:
 * a new enquiry is delivered through the artist destination, never the personal
 * one, so an artist who only ever sees the personal card connects Telegram and
 * still receives nothing. Both destinations are real and are configured here.
 */
export function TelegramConnectionsPage() {
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
    <div className="stack">
      <PersonalTelegramNotifications />

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
    </div>
  );
}
