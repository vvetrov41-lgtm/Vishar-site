import type { ReactNode } from 'react';
import { useLanguage } from '../lib/i18n';

export type ClientMobileTab = 'work' | 'messages' | 'history' | 'details';

const TAB_LABELS: Record<ClientMobileTab, string> = {
  work: 'clientWorkspace.mobileWork',
  messages: 'clientWorkspace.mobileMessages',
  history: 'clientWorkspace.mobileHistory',
  details: 'clientWorkspace.mobileDetails',
};

export function ClientMobileTabs({
  active,
  onChange,
}: {
  active: ClientMobileTab;
  onChange: (tab: ClientMobileTab) => void;
}) {
  const { t } = useLanguage();
  return (
    <nav className="client-mobile-tabs" aria-label={t('clientWorkspace.mobileTabsLabel')}>
      {(Object.keys(TAB_LABELS) as ClientMobileTab[]).map((tab) => (
        <button
          key={tab}
          type="button"
          aria-pressed={active === tab}
          className={active === tab ? 'active' : ''}
          onClick={() => onChange(tab)}
        >
          {t(TAB_LABELS[tab])}
        </button>
      ))}
    </nav>
  );
}

export function ClientMobileTabPanel({
  tab,
  active,
  children,
}: {
  tab: ClientMobileTab;
  active: ClientMobileTab;
  children: ReactNode;
}) {
  return (
    <div
      className="client-mobile-tab-panel"
      data-client-tab={tab}
      data-active={active === tab ? 'true' : 'false'}
      data-testid={`client-tab-${tab}`}
    >
      {children}
    </div>
  );
}
