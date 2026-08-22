// The preflight exists to catch one specific class of accident: a deploy that
// resolves a divergence between live Cloudflare state and tracked config by
// deleting the difference. The first fixture below is the real one, taken from
// live production on 2026-08-22.

import assert from 'node:assert/strict';
import { parseDeployConfig, evaluatePreflight } from './preflight-telegram-production.mjs';

const GENERATED = `
name = "vishar-telegram-drain-production"
compatibility_date = "2026-08-22"
workers_dev = false
preview_urls = false

routes = [
  { pattern = "telegram.vishartattoo.com", zone_name = "vishartattoo.com", custom_domain = true, enabled = true, previews_enabled = false }
]

[vars]
VISHAR_ENVIRONMENT = "production"
SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"
TELEGRAM_DRAIN_ENABLED = "true"
TELEGRAM_LINKING_ENABLED = "false"

[triggers]
crons = ["*/5 * * * *"]
`;

// Exactly what /workers/scripts/vishar-telegram-drain-production/settings returned.
const LIVE = {
  workerExists: true,
  compatibilityDate: '2026-05-25',
  bindings: [
    { name: 'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION', type: 'secret_text' },
    { name: 'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION', type: 'secret_text' },
    { name: 'GMAIL_SERVICE', type: 'service', service: 'vishar-gmail-production' },
    { name: 'GMAIL_SHARED_DRAIN_ENABLED', text: 'true', type: 'plain_text' },
    { name: 'SUPABASE_SECRET_KEY', type: 'secret_text' },
    { name: 'SUPABASE_URL', text: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co', type: 'plain_text' },
    { name: 'TELEGRAM_DRAIN_ENABLED', text: 'true', type: 'plain_text' },
    { name: 'VISHAR_ENVIRONMENT', text: 'production', type: 'plain_text' },
  ],
  secretNames: [
    'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION',
    'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',
    'SUPABASE_SECRET_KEY',
  ],
  workersDevEnabled: false,
  previewUrlsEnabled: false,
  crons: [{ cron: '*/5 * * * *' }],
  customDomains: [
    { hostname: 'whatsapp.vishartattoo.com', service: 'vishar-whatsapp-webhook-production' },
    { hostname: 'instagram.vishartattoo.com', service: 'vishar-instagram-production' },
  ],
  dnsExists: false,
  zoneRoutes: [{ pattern: 'vishartattoo.com/pay-by-bank-transfer*', script: 'vishar-monzo-api-production' }],
  accessApps: [
    { name: 'calendar-production', domain: 'calendar.vishartattoo.com', type: 'self_hosted' },
  ],
  versionId: 'c6fc73e8-281a-4715-86c5-ae2d7d43e9b1',
};

const desired = parseDeployConfig(GENERATED);
assert.deepEqual(desired.crons, ['*/5 * * * *']);
assert.equal(desired.workersDev, false);
assert.equal(desired.previewUrls, false);
assert.equal(desired.customDomain, true);
assert.deepEqual(desired.hostnames, ['telegram.vishartattoo.com']);
assert.equal(desired.vars.TELEGRAM_LINKING_ENABLED, 'false');
assert.equal(desired.vars.TELEGRAM_DRAIN_ENABLED, 'true');

// The real case: production runs a Gmail shared drain this branch knows nothing
// about, and the two new secrets are not provisioned yet.
{
  const verdict = evaluatePreflight({ live: LIVE, desired });
  assert.equal(verdict.ok, false);

  const gmailService = verdict.failures.find((f) => f.includes('GMAIL_SERVICE'));
  const gmailFlag = verdict.failures.find((f) => f.includes('GMAIL_SHARED_DRAIN_ENABLED'));
  assert.ok(gmailService, 'the service binding removal must be a failure');
  assert.ok(gmailFlag, 'the shared-drain flag removal must be a failure');
  assert.match(gmailService, /REMOVE live binding/);

  assert.ok(verdict.failures.some((f) => f.includes('TELEGRAM_BOT_TOKEN')
    && f.includes('TELEGRAM_WEBHOOK_SECRET')), 'unprovisioned secrets must be reported');

  // Secrets survive a deploy, so a live secret must never be reported as removed.
  for (const secret of LIVE.secretNames) {
    assert.equal(
      verdict.failures.some((f) => f.includes('REMOVE live binding') && f.includes(secret)),
      false,
      `${secret} is a secret and is preserved by a deploy`,
    );
  }

  assert.ok(verdict.warnings.some((w) => w.includes('does not exist yet')));
  assert.ok(verdict.warnings.some((w) => w.includes('2026-05-25') && w.includes('2026-08-22')));
  assert.equal(verdict.summary.live_version_id, 'c6fc73e8-281a-4715-86c5-ae2d7d43e9b1');
}

// Once the Gmail bindings are carried and the secrets exist, it passes.
{
  const carried = parseDeployConfig(GENERATED.replace(
    'TELEGRAM_LINKING_ENABLED = "false"',
    'TELEGRAM_LINKING_ENABLED = "false"\nGMAIL_SHARED_DRAIN_ENABLED = "true"\n\n[[services]]\nbinding = "GMAIL_SERVICE"\nservice = "vishar-gmail-production"',
  ));
  const live = {
    ...LIVE,
    secretNames: [...LIVE.secretNames, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].sort(),
  };
  const verdict = evaluatePreflight({ live, desired: carried });
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.ok, true);
}

// A legacy Artist secret disappearing removes the rollback path.
{
  const live = {
    ...LIVE,
    secretNames: ['SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
  };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(verdict.failures.some((f) => f.includes('ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION')
    && f.includes('rollback')));
}

// The hostname must never be taken from another Worker.
{
  const live = {
    ...LIVE,
    customDomains: [...LIVE.customDomains,
      { hostname: 'telegram.vishartattoo.com', service: 'vishar-gpt-actions-production' }],
  };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(verdict.failures.some((f) => f.includes('already a Custom Domain of vishar-gpt-actions-production')));
}

// A DNS record with no Custom Domain is an unresolved state, not a green light.
{
  const verdict = evaluatePreflight({ live: { ...LIVE, dnsExists: true }, desired });
  assert.ok(verdict.failures.some((f) => f.includes('DNS record but no Worker Custom Domain')));
}

// Cloudflare Access in front of the callback would answer Telegram with a login
// redirect instead of reaching the Worker.
for (const domain of ['telegram.vishartattoo.com', 'telegram.vishartattoo.com/webhook', '*.vishartattoo.com']) {
  const live = { ...LIVE, accessApps: [{ name: 'blocker', domain, type: 'self_hosted' }] };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(
    verdict.failures.some((f) => f.includes('Cloudflare Access app "blocker"')),
    `Access on ${domain} must be a failure`,
  );
}

// Linking must stay off at this stage, and the drain must be on.
{
  const linkingOn = parseDeployConfig(GENERATED.replace(
    'TELEGRAM_LINKING_ENABLED = "false"', 'TELEGRAM_LINKING_ENABLED = "true"'));
  assert.ok(evaluatePreflight({ live: LIVE, desired: linkingOn }).failures
    .some((f) => f.includes('TELEGRAM_LINKING_ENABLED')));

  const drainOff = parseDeployConfig(GENERATED.replace(
    'TELEGRAM_DRAIN_ENABLED = "true"', 'TELEGRAM_DRAIN_ENABLED = "false"'));
  assert.ok(evaluatePreflight({ live: LIVE, desired: drainOff }).failures
    .some((f) => f.includes('must enable the drain')));
}

// workers.dev or preview URLs live would expose the callback off its domain.
{
  const verdict = evaluatePreflight({ live: { ...LIVE, workersDevEnabled: true }, desired });
  assert.ok(verdict.failures.some((f) => f.includes('workers.dev is enabled')));
}

// No summary field may carry a secret value.
{
  const verdict = evaluatePreflight({ live: LIVE, desired });
  const printed = JSON.stringify(verdict.summary);
  assert.equal(printed.includes('secret_text'), false);
  assert.ok(printed.includes('SUPABASE_SECRET_KEY'), 'names are reported');
}

console.log('Telegram production preflight tests passed: a deploy may add bindings, never silently remove one production runs on.');
