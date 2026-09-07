import { TelegramConnectionCard } from '../components/TelegramConnectionCard';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { visibleIntegrationArtistIds } from '../lib/integration-visibility';
import { useApi, useSession } from '../lib/session';

/** The single user-facing Telegram integration used for enquiry delivery. */
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
      artistDestinations: destinations.filter(
        (destination) => destination.destination_kind === 'artist'
          && Boolean(destination.artist_id && visibleArtistIds.has(destination.artist_id)),
      ),
    };
  }, [api, memberships, profile]);

  return (
    <Section title="Telegram">
      <p className="notice">
        {language === 'ru'
          ? 'Подключи Telegram для уведомлений о новых заявках выбранного мастера.'
          : 'Connect Telegram for new enquiry notifications for the selected artist.'}
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
              ? 'Telegram можно подключить только для мастеров, чьими интеграциями ты можешь управлять.'
              : 'Telegram can only be connected for artists whose integrations you may manage.'}
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
