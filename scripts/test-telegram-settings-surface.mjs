import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const notifications = await readFile('admin/src/pages/NotificationsPage.tsx', 'utf8');
const integrations = await readFile('admin/src/pages/IntegrationsPage.tsx', 'utf8');
const telegramConnections = await readFile('admin/src/pages/TelegramConnectionsPage.tsx', 'utf8');
const personalTelegram = await readFile('admin/src/components/PersonalTelegramNotifications.tsx', 'utf8');

assert.match(
  notifications,
  /<PersonalTelegramNotifications\s*\/>/,
  'Notifications must render personal Telegram settings.',
);
assert.match(
  notifications,
  /<ArtistTelegramNotifications\s*\/>/,
  'Notifications must render artist Telegram settings.',
);
assert.match(
  notifications,
  /canAccess\(profile\?\.role,\s*'manageIntegrations',\s*memberships\)/,
  'Artist Telegram settings must stay behind manageIntegrations.',
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
  'Artist Telegram settings must remain reusable for the Notifications page.',
);
assert.doesNotMatch(
  telegramConnections,
  /PersonalTelegramNotifications/,
  'The legacy Telegram deep-link page must not duplicate personal Telegram settings.',
);

assert.match(
  personalTelegram,
  /Новые заявки отправляются в «Telegram мастеров» ниже\./,
  'Personal Telegram copy must explain where new enquiries are delivered.',
);

console.log('Telegram settings surface contract passed.');
