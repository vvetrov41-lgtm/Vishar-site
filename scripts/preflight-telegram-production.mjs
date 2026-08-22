// Validation-only preflight for the production Telegram Worker.
//
// This exists because live Cloudflare state and the tracked configuration had
// silently diverged, and `wrangler deploy --strict` would have resolved that
// divergence by deleting the difference.
//
// Production `vishar-telegram-drain-production` carries a GMAIL_SERVICE service
// binding and GMAIL_SHARED_DRAIN_ENABLED, added by the Gmail shared-cron work.
// That work is not in this branch's lineage, so a deploy from here would drop
// both and stop the Gmail outbox draining, with nothing in CI to notice.
// Secrets survive a deploy; plain-text vars and service bindings do not.
//
// So the rule this enforces is narrow and absolute: a deploy may add bindings,
// never silently remove one that production is currently running on.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/preflight-telegram-production.mjs <generated-deploy-config.toml>
//
// It reads only. It never prints a secret value - secret names only.

const WORKER = 'vishar-telegram-drain-production';
const ZONE = 'vishartattoo.com';
const HOSTNAME = 'telegram.vishartattoo.com';
const WEBHOOK_PATH = '/webhook';

const REQUIRED_SECRET_NAMES = [
  'ARTIST_TELEGRAM_KRISTINA_HPRODUCTION',
  'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',
  'SUPABASE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
];

// Removing one of these would end a legacy Artist's Telegram delivery with no
// DB-backed destination yet proven to replace it.
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

  // [vars] runs until the next table header. Walk the lines rather than trying
  // to express "until the next section or end of file" as one regex.
  const vars = {};
  let inVars = false;
  for (const line of stripped.split('\n')) {
    const header = /^\s*\[\[?([A-Za-z0-9_.]+)\]?\]\s*$/.exec(line);
    if (header) { inVars = header[1] === 'vars'; continue; }
    if (!inVars) continue;
    const kv = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (kv) vars[kv[1]] = kv[2];
  }

  const services = [...stripped.matchAll(/^\s*binding\s*=\s*"([A-Za-z0-9_]+)"/gm)].map((m) => m[1]);
  const compatMatch = /^\s*compatibility_date\s*=\s*"([^"]+)"/m.exec(stripped);
  const cronMatch = /crons\s*=\s*\[([^\]]*)\]/.exec(stripped);
  const crons = cronMatch
    ? [...cronMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : [];

  return {
    vars,
    compatibilityDate: compatMatch ? compatMatch[1] : null,
    // Everything a deploy replaces wholesale: plain-text vars plus non-secret bindings.
    replaceableBindings: [...Object.keys(vars), ...services].sort(),
    crons,
    workersDev: bool('workers_dev'),
    previewUrls: bool('preview_urls'),
    hostnames: [...stripped.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
    customDomain: /custom_domain\s*=\s*true/.test(stripped),
  };
}

export function evaluatePreflight({ live, desired, hostname = HOSTNAME }) {
  const failures = [];
  const warnings = [];

  if (!live.workerExists) failures.push(`Worker ${WORKER} does not exist`);

  // The whole reason this file exists.
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

  // The hostname must be free, or already ours. Never someone else's.
  const attached = (live.customDomains || []).find((d) => d.hostname === hostname);
  if (attached && attached.service !== WORKER) {
    failures.push(`${hostname} is already a Custom Domain of ${attached.service}`);
  }
  if (!attached && live.dnsExists) {
    failures.push(`${hostname} has a DNS record but no Worker Custom Domain; resolve that first`);
  }
  if (!attached && !live.dnsExists) {
    warnings.push(`${hostname} does not exist yet; the deploy will create it`);
  }

  const conflictingRoute = (live.zoneRoutes || [])
    .find((r) => r.pattern.includes(hostname) && r.script !== WORKER);
  if (conflictingRoute) {
    failures.push(`zone route ${conflictingRoute.pattern} points at ${conflictingRoute.script}`);
  }

  // Cloudflare Access in front of a provider callback makes Telegram's POST fail
  // a login redirect instead of reaching the Worker.
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

  if (desired.vars.TELEGRAM_LINKING_ENABLED !== 'false') {
    failures.push('deploy config must keep TELEGRAM_LINKING_ENABLED = "false" at this stage');
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
      custom_domain_exists: Boolean(attached),
      dns_exists: Boolean(live.dnsExists),
      desired_bindings: desired.replaceableBindings,
      desired_crons: desired.crons,
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
  const dns = zoneId ? await cf(`/zones/${zoneId}/dns_records`, { name: HOSTNAME }, token) : [];
  const zoneRoutes = zoneId ? await cf(`/zones/${zoneId}/workers/routes`, {}, token) : [];
  let accessApps = [];
  try { accessApps = await cf(`/accounts/${accountId}/access/apps`, {}, token); } catch { accessApps = []; }

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
    zoneRoutes: zoneRoutes || [],
    accessApps: accessApps || [],
    versionId: deployments?.deployments?.[0]?.versions?.[0]?.version_id || null,
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const { readFileSync } = await import('node:fs');
  const args = process.argv.slice(2);
  // Validation-only runs happen before the shared bot secrets exist, so they
  // report rather than gate. The pre-deploy run gates.
  const reportOnly = args.includes('--report-only');
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) {
    console.error('usage: preflight-telegram-production.mjs <generated-deploy-config.toml>');
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
  const verdict = evaluatePreflight({ live, desired });

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
