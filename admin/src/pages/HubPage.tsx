// Money and Settings hubs.
//
// The phone's More sheet lists one entry per hub instead of every money and
// setup screen. A hub is only an index: each row opens a screen that already
// existed at its own URL, and it lists exactly the destinations the shell
// would have shown this person, so no capability is decided here.

import { EmptyState, Section } from '../components/StateViews';
import { HUB_PATHS, NAV_KEYS, navGroupFor, useNavItems } from '../components/AppShell';
import { useLanguage, type Language } from '../lib/i18n';
import { Link } from '../lib/router';

type HubGroup = keyof typeof HUB_PATHS;

// One line saying what the screen is for, so the hub answers "where do I
// change X" without opening each screen in turn.
const HINTS: Record<Language, Record<string, string>> = {
  en: {
    '/invoices': 'Issue, send and track invoices.',
    '/payments': 'Deposits, payment links and bank reconciliation.',
    '/availability': 'Holidays and blocked time in the diary.',
    '/automations': 'Reminders and messages the CRM sends by itself.',
    '/integrations': 'Booking forms, Calendar, Telegram, WhatsApp and Instagram.',
    '/notifications': 'What the CRM tells you about, and where.',
    '/workspaces': 'Studios, artists and their administration.',
    '/users': 'Who can sign in and what they can do.',
    '/activity': 'Every change recorded in the CRM.',
  },
  ru: {
    '/invoices': 'Выставление, отправка и контроль счетов.',
    '/payments': 'Депозиты, ссылки на оплату и сверка с банком.',
    '/availability': 'Отпуска и заблокированное время в календаре.',
    '/automations': 'Напоминания и сообщения, которые CRM отправляет сама.',
    '/integrations': 'Формы записи, Calendar, Telegram, WhatsApp и Instagram.',
    '/notifications': 'О чём CRM сообщает вам и куда.',
    '/workspaces': 'Студии, мастера и их администрирование.',
    '/users': 'Кто может войти и что ему доступно.',
    '/activity': 'Все изменения, записанные в CRM.',
  },
};

export function HubPage({ group }: { group: HubGroup }) {
  const { t, language } = useLanguage();
  const items = useNavItems().filter((item) => navGroupFor(item.path) === group);
  const title = group === 'money' ? t('nav.money') : t('nav.settings');

  if (items.length === 0) {
    return <EmptyState title={t('app.pageNotFound')} hint={t('app.useNavigation')} />;
  }

  return (
    <Section title={title}>
      <div className="list">
        {items.map((item) => {
          const name = item.path === '/automations'
            ? (language === 'ru' ? 'Автоматические сообщения' : 'Automatic messages')
            : t(NAV_KEYS[item.path] ?? item.label);
          const hint = HINTS[language][item.path];
          return (
            <Link key={item.path} to={item.path} className="row">
              <div className="title">{name}</div>
              {hint ? <div className="meta">{hint}</div> : null}
            </Link>
          );
        })}
      </div>
    </Section>
  );
}
