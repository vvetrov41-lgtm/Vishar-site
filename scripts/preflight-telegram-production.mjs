// Validation-only preflight for the production Telegram Worker.
//
// This exists because live Cloudflare state and the tracked configuration had
// silently diverged, and `wrangler deploy --strict` would have resolved that
// divergence by deleting the difference.
//
// Production `vishar-telegram-drain-production` carries a GMAIL_SERVICE service
// binding and GMAIL_SHARED_DRAIN_ENABLED, added by the Gmail shared-cron work.
// That contract must survive every Telegram self-service deployment. Gmail
// credentials stay on the Gmail Worker; this Worker may call only the bounded
// Service Binding RPC.
//
// So the rule this enforces is narrow and absolute: a deploy may add bindings,
// never silently remove one that production is currently running on, and it may
// not change live Telegram linking state without an explicit gate.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/preflight-telegram-production.mjs <generated-deploy-config.toml>
//
// It reads only. It never prints a secret value - secret names only.

const WORKER = 'vishar-telegram-drain-production';
const ZONE = 'vishartattoo.com';
const HOSTNAME = 'telegram.vishartattoo.com';
const WEBHOOK_PATH = '/webhook';
const GMAIL_SERVICE = 'vishar-gmail-production';

const REQUIRED_SECRET_NAMES = [
  'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION',
  'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',
  'SUPABASE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
];

const LEGACY_FALLBACK_SECRETS = [
  'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION',
  'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',
];

export function parseDeployConfig(toml) {
  const stripped = toml.replace(/^\s*#.*$/gm, '');

  const bool = (key) => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, 'm').exec(stripped);
    return match ? match[1] === 'true' : null;
  };

  const vars = {};
  const services = {};
  let section = null;
  let serviceBinding = null;
  let serviceTarget = null;
  const flushService = () => {
    if (serviceBinding && serviceTarget) services[serviceBinding] = serviceTarget;
    serviceBinding = null;
    serviceTarget = null;
  };

  for (const line of stripped.split('\n')) {
    const arrayHeader = /^\s*\[\[([A-Za-z0-9_.]+)\]\]\s*$/.exec(line);
    if (arrayHeader) {
      if (section === 'services') flushService();
      section = arrayHeader[1];
      continue;
    }
    const tableHeader = /^\s*\[([A-Za-z0-9_.]+)\]\s*$/.exec(line);
    if (tableHeader) {
      if (section === 'services') flushService();
      section = tableHeader[1];
      continue;
    }

    if (section === 'vars') {
      const kv = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
      if (kv) vars[kv[1]] = kv[2];
    } else if (section === 'services') {
      const binding = /^\s*binding\s*=\s*"([A-Za-z0-9_]+)"/.exec(line);
      if (binding) serviceBinding = binding[1];
      const service = /^\s*service\s*=\s*"([A-Za-z0-9_-]+)"/.exec(line);
      if (service) serviceTarget = service[1];
    }
  }
  if (section === 'services') flushService();

  const compatMatch = /^\s*compatibility_date\s*=\s*"([^"]+)"/m.exec(stripped);
  const cronMatch = /crons\s*=\s*\[([^\]]*)\]/.exec(stripped);
  const crons = cronMatch
    ? [...cronMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : [];

  return {
    vars,
    services,
    compatibilityDate: compatMatch ? compatMatch[1] : null,
    replaceableBindings: [...Object.keys(vars), ...Object.keys(services)].sort(),
    crons,
    workersDev: bool('workers_dev'),
    previewUrls: bool('preview_urls'),
    hostnames: [...stripped.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
    customDomain: /custom_domain\s*=\s*true/.test(stripped),
  };
}

export function evaluatePreflight({
  live,
  desired,
  hostname = HOSTNAME,
  allowLinking = false,
  allowLinkingDisable = false,
}) {
  const failures = [];
  const warnings = [];

  if (!live.workerExists) failures.push(`Worker ${WORKER} does not exist`);
  if (live.zoneResolved === false) {
    failures.push(`Cloudflare zone ${ZONE} could not be resolved; DNS and route safety are unverified`);
  }
  if (live.accessCheckAvailable === false) {
    failures.push(`Cloudflare Access state for ${HOSTNAME} could not be verified; callback exposure is unverified`);
  }

  const liveReplaceable = (live.bindings || [])
    .filter((b) => b.type !== 'secret_text')
    .map((b) => b.name);
  const removed = liveReplaceable.filter((name) => !desired.replaceableBindings.includes(name));
  for (const name of removed) {
    failures.push(
      `deploy would REMOVE live binding ${name}; production is running on it. `
      + 'Add it to the deploy config or land the branch that owns it first.',
    );
  }

  const liveGmailService = (live.bindings || []).find((b) => b.name === 'GMAIL_SERVICE');
  if (liveGmailService && liveGmailService.service !== GMAIL_SERVICE) {
    failures.push(`live GMAIL_SERVICE points at ${liveGmailService.service || 'unknown'}, expected ${GMAIL_SERVICE}`);
  }
  const liveGmailEnabled = (live.bindings || []).find((b) => b.name === 'GMAIL_SHARED_DRAIN_ENABLED');
  if (liveGmailEnabled && liveGmailEnabled.text !== 'true') {
    failures.push('live GMAIL_SHARED_DRAIN_ENABLED is not true; investigate before a deploy can re-enable it');
  }

  if (desired.vars.GMAIL_SHARED_DRAIN_ENABLED !== 'true') {
    failures.push('deploy config must preserve GMAIL_SHARED_DRAIN_ENABLED = "true"');
  }
  if (desired.services.GMAIL_SERVICE !== GMAIL_SERVICE) {
    failures.push(`deploy config must bind GMAIL_SERVICE to ${GMAIL_SERVICE}`);
  }

  const liveSecretNames = (live.secretNames || []).slice().sort();
  for (const name of LEGACY_FALLBACK_SECRETS) {
    if (!liveSecretNames.includes(name)) {
      failures.push(`legacy fallback secret ${name} is missing; rollback would have no path`);
    }
  }
  const missingSecrets = REQUIRED_SECRET_NAMES.filter((n) => !liveSecretNames.includes(n));
  if (missingSecrets.length) {
    failures.push(`required secret names not provisioned: ${missingSecrets.join(', ')}`);
  }

  if (live.workersDevEnabled) failures.push('workers.dev is enabled on the live Worker');
  if (live.previewUrlsEnabled) failures.push('preview URLs are enabled on the live Worker');
  if (desired.workersDev !== false) failures.push('deploy config does not set workers_dev = false');
  if (desired.previewUrls !== false) failures.push('deploy config does not set preview_urls = false');

  const attached = (live.customDomains || []).find((d) => d.hostname === hostname);
  if (attached && attached.service !== WORKER) {
    failures.push(`${hostname} is already a Custom Domain of ${attached.service}`);
  }
  if (!attached && live.dnsExists) {
    failures.push(`${hostname} has a DNS record but no Worker Custom Domain; resolve that first`);
  }
  if (!attached && !live.dnsExists && live.zoneResolved !== false) {
    warnings.push(`${hostname} does not exist yet; the deploy will create it`);
  }

  const conflictingRoute = (live.zoneRoutes || [])
    .find((r) => r.pattern.includes(hostname) && r.script !== WORKER);
  if (conflictingRoute) {
    failures.push(`zone route ${conflictingRoute.pattern} points at ${conflictingRoute.script}`);
  }

  const blockingAccess = (live.accessApps || []).filter((a) => {
    const domain = String(a.domain || '');
    return domain === hostname
      || domain.startsWith(`${hostname}/`)
      || domain === `*.${ZONE}`;
  });
  for (const app of blockingAccess) {
    failures.push(
      `Cloudflare Access app "${app.name}" covers ${app.domain} and would intercept ${hostname}${WEBHOOK_PATH}`,
    );
  }

  if (!desired.hostnames.includes(hostname)) {
    failures.push(`deploy config does not declare ${hostname}`);
  }
  if (!desired.customDomain) failures.push('deploy config does not declare a Custom Domain route');

  const desiredLinking = desired.vars.TELEGRAM_LINKING_ENABLED;
  if (!['false', 'true'].includes(desiredLinking)) {
    failures.push('deploy config must explicitly set TELEGRAM_LINKING_ENABLED to true or false');
  } else if (desiredLinking === 'true' && !allowLinking) {
    failures.push('linking-enabled deploy requires the explicit --allow-linking preflight gate');
  }

  const liveLinking = (live.bindings || []).find((b) => b.name === 'TELEGRAM_LINKING_ENABLED');
  if (liveLinking?.text === 'true' && desiredLinking === 'false' && !allowLinkingDisable) {
    failures.push('deploy would disable live Telegram linking; use the explicit --allow-linking-disable rollback gate');
  }

  if (desired.vars.TELEGRAM_DRAIN_ENABLED !== 'true') {
    failures.push('generated deploy config must enable the drain');
  }

  const liveCrons = (live.crons || []).map((c) => c.cron);
  if (JSON.stringify(liveCrons) !== JSON.stringify(desired.crons)) {
    warnings.push(`cron changes from [${liveCrons.join(', ')}] to [${desired.crons.join(', ')}]`);
  }

  if (live.compatibilityDate && desired.compatibilityDate
      && live.compatibilityDate !== desired.compatibilityDate) {
    warnings.push(
      `compatibility date changes from ${live.compatibilityDate} to ${desired.compatibilityDate}`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary: {
      worker: WORKER,
      live_version_id: live.versionId || null,
      live_bindings_replaceable: liveReplaceable.sort(),
      live_secret_names: liveSecretNames,
      live_crons: liveCrons,
      live_workers_dev: Boolean(live.workersDevEnabled),
      live_preview_urls: Boolean(live.previewUrlsEnabled),
      zone_resolved: live.zoneResolved !== false,
      access_check_available: live.accessCheckAvailable !== false,
      custom_domain_exists: Boolean(attached),
      dns_exists: Boolean(live.dnsExists),
      desired_bindings: desired.replaceableBindings,
      desired_crons: desired.crons,
      desired_linking_enabled: desiredLinking === 'true',
      gmail_shared_drain_preserved: desired.services.GMAIL_SERVICE === GMAIL_SERVICE
        && desired.vars.GMAIL_SHARED_DRAIN_ENABLED === 'true',
    },
  };
}

async function cf(path, query, token) {
  const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!body?.success) {
    throw new Error(`Cloudflare ${path} failed: ${JSON.stringify(body?.errors || []).slice(0, 200)}`);
  }
  return body.result;
}

export async function collectLiveState(token, accountId) {
  const settings = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/settings`, {}, token);
  const secrets = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/secrets`, {}, token);
  const subdomain = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/subdomain`, {}, token);
  const schedules = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/schedules`, {}, token);
  const domains = await cf(`/accounts/${accountId}/workers/domains`, {}, token);
  const deployments = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/deployments`, {}, token);
  const zones = await cf('/zones', { name: ZONE }, token);
  const zoneId = zones?.[0]?.id;
  const zoneResolved = Boolean(zoneId);
  const dns = zoneId ? await cf(`/zones/${zoneId}/dns_records`, { name: HOSTNAME }, token) : [];
  const zoneRoutes = zoneId ? await cf(`/zones/${zoneId}/workers/routes`, {}, token) : [];
  let accessApps = [];
  let accessCheckAvailable = true;
  try {
    accessApps = await cf(`/accounts/${accountId}/access/apps`, {}, token);
  } catch {
    accessCheckAvailable = false;
  }

  return {
    workerExists: true,
    bindings: settings?.bindings || [],
    compatibilityDate: settings?.compatibility_date || null,
    secretNames: (secrets || []).map((s) => s.name),
    workersDevEnabled: Boolean(subdomain?.enabled),
    previewUrlsEnabled: Boolean(subdomain?.previews_enabled),
    crons: schedules?.schedules || [],
    customDomains: domains || [],
    dnsExists: (dns || []).length > 0,
    zoneResolved,
    zoneRoutes: zoneRoutes || [],
    accessApps: accessApps || [],
    accessCheckAvailable,
    versionId: deployments?.deployments?.[0]?.versions?.[0]?.version_id || null,
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const { readFileSync } = await import('node:fs');
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report-only');
  const allowLinking = args.includes('--allow-linking');
  const allowLinkingDisable = args.includes('--allow-linking-disable');
  const knownFlags = new Set(['--report-only', '--allow-linking', '--allow-linking-disable']);
  for (const arg of args.filter((a) => a.startsWith('--'))) {
    if (!knownFlags.has(arg)) {
      console.error(`unknown option: ${arg}`);
      process.exit(1);
    }
  }
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) {
    console.error(
      'usage: preflight-telegram-production.mjs <generated-deploy-config.toml> '
      + '[--report-only] [--allow-linking] [--allow-linking-disable]',
    );
    process.exit(1);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
    process.exit(1);
  }

  const desired = parseDeployConfig(readFileSync(configPath, 'utf8'));
  const live = await collectLiveState(token, accountId);
  const verdict = evaluatePreflight({
    live,
    desired,
    allowLinking,
    allowLinkingDisable,
  });

  console.log(JSON.stringify(verdict.summary, null, 2));
  for (const warning of verdict.warnings) console.log(`warning: ${warning}`);
  for (const failure of verdict.failures) {
    console.error(`${reportOnly ? 'NOT READY' : 'FAIL'}: ${failure}`);
  }
  if (reportOnly) {
    console.log(verdict.ok
      ? 'preflight: production is ready for this deploy config'
      : `preflight: ${verdict.failures.length} blocker(s) must be resolved before deploy=true`);
    process.exit(0);
  }
  process.exit(verdict.ok ? 0 : 1);
}
