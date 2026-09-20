import { useState } from 'react';
import { ActivityFeed } from '../components/ActivityFeed';
import { useLanguage } from '../lib/i18n';
import { ACTIVITY_EVENT_TYPES, operationalLabel } from '../lib/operational-labels';
import { useArtistScope } from '../lib/artist-scope';

export function ActivityPage() {
  const { t, language } = useLanguage();
  const [eventType, setEventType] = useState('');
  const { selectedArtistId } = useArtistScope();

  const eventTypes = [...ACTIVITY_EVENT_TYPES].sort((left, right) =>
    operationalLabel(language, 'event', left)
      .localeCompare(operationalLabel(language, 'event', right), language)
  );

  return (
    <>
      <div className="card">
        <label htmlFor="event-type">{t('activity.filter')}</label>
        <select
          id="event-type"
          value={eventType}
          onChange={(event) => setEventType(event.target.value)}
        >
          <option value="">{language === 'ru' ? 'Все события' : 'All events'}</option>
          {eventTypes.map((type) => (
            <option key={type} value={type}>
              {operationalLabel(language, 'event', type)}
            </option>
          ))}
        </select>
        <p className="notice" style={{ marginTop: 12 }}>{t('activity.notice')}</p>
      </div>

      <ActivityFeed
        filter={{
          eventType: eventType || undefined,
          artistId: selectedArtistId ?? undefined,
        }}
      />
    </>
  );
}
