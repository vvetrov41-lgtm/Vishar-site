import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const notifications = await readFile('admin/src/pages/NotificationsPage.tsx', 'utf8');
const integrations = await readFile('admin/src/pages/IntegrationsPage.tsx', 'utf8');
const telegramConnections = await readFile('admin/src/pages/TelegramConnectionsPage.tsx', 'utf8');

assert.doesNotMatch(
  notifications,
  /PersonalTelegramNotifications/,
  'Notifications must not render the legacy personal Telegram integration.',
);
assert.match(
  notifications,
  /<ArtistTelegramNotifications\s*\/>/,
  'Notifications must render the single artist-bound Telegram integration.',
);
assert.match(
  notifications,
  /canAccess\(profile\?\.role,\s*'manageIntegrations',\s*memberships\)/,
  'Telegram settings must stay behind manageIntegrations.',
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
  'The single Telegram integration must remain reusable on Notifications.',
);
assert.doesNotMatch(
  telegramConnections,
  /PersonalTelegramNotifications/,
  'The compatibility Telegram route must not restore the legacy personal integration.',
);
assert.match(
  telegramConnections,
  /<Section title="Telegram">/,
  'The visible integration must be presented simply as Telegram, not as a second artist-specific product.',
);

console.log('Single Telegram settings integration contract passed.');
