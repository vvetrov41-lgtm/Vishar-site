// The preflight exists to catch one specific class of accident: a deploy that
// resolves a divergence between live Cloudflare state and tracked config by
// deleting or changing the difference. The LIVE fixture is the real production
// shape observed through Cloudflare on 2026-08-22.

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
GMAIL_SHARED_DRAIN_ENABLED = "true"
TELEGRAM_LINKING_ENABLED = "false"

[[services]]
binding = "GMAIL_SERVICE"
service = "vishar-gmail-production"

[triggers]
crons = ["*/5 * * * *"]
`;

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
assert.equal(desired.vars.GMAIL_SHARED_DRAIN_ENABLED, 'true');
assert.equal(desired.services.GMAIL_SERVICE, 'vishar-gmail-production');
assert.ok(desired.replaceableBindings.includes('GMAIL_SERVICE'));
assert.ok(desired.replaceableBindings.includes('GMAIL_SHARED_DRAIN_ENABLED'));

{
  const verdict = evaluatePreflight({ live: LIVE, desired });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.some((f) => f.includes('REMOVE live binding')), false);
  assert.equal(verdict.failures.some((f) => f.includes('GMAIL_SERVICE')), false);
  assert.equal(verdict.failures.some((f) => f.includes('GMAIL_SHARED_DRAIN_ENABLED')), false);
  assert.ok(verdict.failures.some((f) => f.includes('TELEGRAM_BOT_TOKEN')
    && f.includes('TELEGRAM_WEBHOOK_SECRET')));
  for (const secret of LIVE.secretNames) {
    assert.equal(
      verdict.failures.some((f) => f.includes('REMOVE live binding') && f.includes(secret)),
      false,
    );
  }
  assert.ok(verdict.warnings.some((w) => w.includes('does not exist yet')));
  assert.ok(verdict.warnings.some((w) => w.includes('2026-05-25') && w.includes('2026-08-22')));
  assert.equal(verdict.summary.live_version_id, 'c6fc73e8-281a-4715-86c5-ae2d7d43e9b1');
  assert.equal(verdict.summary.gmail_shared_drain_preserved, true);
}

const READY_LIVE = {
  ...LIVE,
  secretNames: [...LIVE.secretNames, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].sort(),
};
{
  const verdict = evaluatePreflight({ live: READY_LIVE, desired });
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.ok, true);
}

{
  const missingGmail = parseDeployConfig(GENERATED
    .replace('GMAIL_SHARED_DRAIN_ENABLED = "true"\n', '')
    .replace('\n[[services]]\nbinding = "GMAIL_SERVICE"\nservice = "vishar-gmail-production"\n', '\n'));
  const verdict = evaluatePreflight({ live: READY_LIVE, desired: missingGmail });
  assert.ok(verdict.failures.some((f) => f.includes('REMOVE live binding GMAIL_SERVICE')));
  assert.ok(verdict.failures.some((f) => f.includes('REMOVE live binding GMAIL_SHARED_DRAIN_ENABLED')));
  assert.ok(verdict.failures.some((f) => f.includes('must bind GMAIL_SERVICE')));
}

{
  const badTarget = {
    ...READY_LIVE,
    bindings: READY_LIVE.bindings.map((b) => b.name === 'GMAIL_SERVICE'
      ? { ...b, service: 'wrong-worker' }
      : b),
  };
  assert.ok(evaluatePreflight({ live: badTarget, desired }).failures
    .some((f) => f.includes('live GMAIL_SERVICE points at wrong-worker')));

  const disabledGmail = {
    ...READY_LIVE,
    bindings: READY_LIVE.bindings.map((b) => b.name === 'GMAIL_SHARED_DRAIN_ENABLED'
      ? { ...b, text: 'false' }
      : b),
  };
  assert.ok(evaluatePreflight({ live: disabledGmail, desired }).failures
    .some((f) => f.includes('GMAIL_SHARED_DRAIN_ENABLED is not true')));
}

{
  const live = {
    ...READY_LIVE,
    secretNames: ['SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
  };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(verdict.failures.some((f) => f.includes('ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION')
    && f.includes('rollback')));
}

{
  const live = {
    ...READY_LIVE,
    customDomains: [...READY_LIVE.customDomains,
      { hostname: 'telegram.vishartattoo.com', service: 'vishar-gpt-actions-production' }],
  };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(verdict.failures.some((f) => f.includes('already a Custom Domain of vishar-gpt-actions-production')));
}

{
  const verdict = evaluatePreflight({ live: { ...READY_LIVE, dnsExists: true }, desired });
  assert.ok(verdict.failures.some((f) => f.includes('DNS record but no Worker Custom Domain')));
}

for (const domain of ['telegram.vishartattoo.com', 'telegram.vishartattoo.com/webhook', '*.vishartattoo.com']) {
  const live = { ...READY_LIVE, accessApps: [{ name: 'blocker', domain, type: 'self_hosted' }] };
  const verdict = evaluatePreflight({ live, desired });
  assert.ok(verdict.failures.some((f) => f.includes('Cloudflare Access app "blocker"')));
}

{
  const linkingOn = parseDeployConfig(GENERATED.replace(
    'TELEGRAM_LINKING_ENABLED = "false"', 'TELEGRAM_LINKING_ENABLED = "true"'));
  assert.ok(evaluatePreflight({ live: READY_LIVE, desired: linkingOn }).failures
    .some((f) => f.includes('explicit --allow-linking')));
  assert.deepEqual(
    evaluatePreflight({ live: READY_LIVE, desired: linkingOn, allowLinking: true }).failures,
    [],
  );

  const drainOff = parseDeployConfig(GENERATED.replace(
    'TELEGRAM_DRAIN_ENABLED = "true"', 'TELEGRAM_DRAIN_ENABLED = "false"'));
  assert.ok(evaluatePreflight({ live: READY_LIVE, desired: drainOff }).failures
    .some((f) => f.includes('must enable the drain')));
}

// Linking rollback is also explicit: normal deploys cannot silently disable a
// live webhook, but the dedicated rollback gate can close it.
{
  const liveLinking = {
    ...READY_LIVE,
    bindings: [...READY_LIVE.bindings,
      { name: 'TELEGRAM_LINKING_ENABLED', text: 'true', type: 'plain_text' }],
  };
  assert.ok(evaluatePreflight({ live: liveLinking, desired }).failures
    .some((f) => f.includes('explicit --allow-linking-disable')));
  assert.deepEqual(
    evaluatePreflight({
      live: liveLinking,
      desired,
      allowLinkingDisable: true,
    }).failures,
    [],
  );
}

{
  const verdict = evaluatePreflight({ live: { ...READY_LIVE, workersDevEnabled: true }, desired });
  assert.ok(verdict.failures.some((f) => f.includes('workers.dev is enabled')));
}

{
  const verdict = evaluatePreflight({ live: LIVE, desired });
  const printed = JSON.stringify(verdict.summary);
  assert.equal(printed.includes('secret_text'), false);
  assert.ok(printed.includes('SUPABASE_SECRET_KEY'));
}

console.log('Telegram production preflight tests passed: Gmail shared drain and both linking state transitions are explicitly gated.');
