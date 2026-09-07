import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const notifications = await readFile('admin/src/pages/NotificationsPage.tsx', 'utf8');
const integrations = await readFile('admin/src/pages/IntegrationsPage.tsx', 'utf8');
const telegramConnections = await readFile('admin/src/pages/TelegramConnectionsPage.tsx', 'utf8');
const personalTelegram = await readFile('admin/src/components/PersonalTelegramNotifications.tsx', 'utf8');

assert.match(
  notifications,
  /<PersonalTelegramNotifications\s*\/>/,
  'Notifications must render the single profile Telegram settings card.',
);
assert.doesNotMatch(
  notifications,
  /ArtistTelegramNotifications/,
  'Notifications must not expose a second artist Telegram settings surface.',
);
assert.doesNotMatch(
  notifications,
  /canAccess\(profile\?\.role,\s*'manageIntegrations',\s*memberships\)/,
  'The single Telegram card must not depend on artist integration-management capability.',
);

assert.doesNotMatch(
  integrations,
  /telegram:\s*'\/integrations\/telegram'/,
  'The integrations hub must not route users to a second Telegram settings surface.',
);
assert.doesNotMatch(
  integrations,
  /AvailableTelegramCard/,
  'The integrations hub must not advertise Telegram as a separate connection.',
);
assert.doesNotMatch(
  integrations,
  /data-integration=["']telegram["']/,
  'The integrations hub must not render a Telegram status card.',
);

assert.match(
  telegramConnections,
  /export function ArtistTelegramNotifications\(\)/,
  'The retained deep-link compatibility component must remain isolated from Notifications.',
);
assert.doesNotMatch(
  telegramConnections,
  /PersonalTelegramNotifications/,
  'The legacy Telegram deep-link page must not duplicate the profile Telegram settings.',
);

assert.match(
  personalTelegram,
  /Новые заявки и личные уведомления CRM приходят через это единственное подключение\./,
  'Telegram copy must state that enquiries and personal CRM notifications share one connection.',
);
assert.doesNotMatch(
  personalTelegram,
  /Telegram мастеров|Personal Telegram|Личный Telegram/,
  'The single Telegram card must not direct users toward a second artist or personal Telegram connection.',
);

console.log('Telegram settings surface contract passed.');
