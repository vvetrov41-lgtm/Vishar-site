import { useState } from 'react';
import { EmptyState } from './StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { operationalLabel } from '../lib/operational-labels';
import type { ActivityEntry } from '../lib/types';

export function CollapsibleActivityLog({ activity }: { activity: ActivityEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const { t, label, language } = useLanguage();

  if (activity.length === 0) {
    return <EmptyState title={t('enquiry.noActivity')} />;
  }

  const visibleActivity = expanded ? activity : activity.slice(0, 1);
  const actionLabel = expanded
    ? (language === 'ru' ? 'Свернуть' : 'Collapse')
    : (language === 'ru' ? 'Развернуть' : 'Expand');
  const accessibleLabel = expanded
    ? (language === 'ru' ? 'Свернуть журнал действий' : 'Collapse activity log')
    : (language === 'ru' ? 'Развернуть журнал действий' : 'Expand activity log');

  return (
    <>
      <ul className="timeline">
        {visibleActivity.map((entry) => (
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
      {activity.length > 1 ? (
        <div className="actions">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={accessibleLabel}
            onClick={() => setExpanded((value) => !value)}
          >
            {actionLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}
