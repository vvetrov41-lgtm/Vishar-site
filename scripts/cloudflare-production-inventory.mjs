#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const VISHAR_NAME = /(vishar|tattooai|kristina|kisa)/i;
const SENSITIVE_NAME = /(secret|token|password|private|credential|client_secret|api_key|publishable_key|webhook_secret|access_aud)/i;
const HTTP_BOUNDARIES = Object.freeze([
  'https://crm.vishartattoo.com/',
  'https://vishar-crm-production.pages.dev/',
  'https://booking.vishartattoo.com/',
  'https://calendar.vishartattoo.com/',
  'https://gmail.vishartattoo.com/',
  'https://gpt-actions.vishartattoo.com/',
  'https://gpt-operations.vishartattoo.com/',
  'https://instagram.vishartattoo.com/',
  'https://monzo.vishartattoo.com/',
  'https://pay.vishartattoo.com/',
  'https://team.vishartattoo.com/',
  'https://telegram.vishartattoo.com/',
  'https://whatsapp.vishartattoo.com/',
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { output: '', summary: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--output') args.output = argv[++index] || '';
    else if (value === '--summary') args.summary = argv[++index] || '';
    else fail(`Unknown argument: ${value}`);
  }
  if (!args.output || !args.summary) fail('--output and --summary are required');
  return args;
}

function sortBy(rows, key) {
  return [...rows].sort((left, right) => String(left?.[key] ?? '').localeCompare(String(right?.[key] ?? '')));
}

function listRows(value, label, nestedKeys = []) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  for (const key of nestedKeys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  fail(`Cloudflare ${label} list response shape is unsupported`);
}

function safeBinding(binding) {
  const row = { name: binding?.name ?? null, type: binding?.type ?? 'unknown' };
  switch (binding?.type) {
    case 'plain_text':
      row.value = SENSITIVE_NAME.test(binding?.name ?? '') ? '[redacted]' : binding?.text ?? null;
      break;
    case 'service':
      row.service = binding?.service ?? null;
      row.environment = binding?.environment ?? null;
      break;
    case 'kv_namespace':
      row.namespace_id = binding?.namespace_id ?? null;
      break;
    case 'r2_bucket':
      row.bucket_name = binding?.bucket_name ?? null;
      break;
    case 'd1':
      row.database_id = binding?.id ?? binding?.database_id ?? null;
      break;
    case 'durable_object_namespace':
      row.class_name = binding?.class_name ?? null;
      row.script_name = binding?.script_name ?? null;
      row.environment = binding?.environment ?? null;
      break;
    case 'ratelimit':
      row.namespace_id = binding?.namespace_id ?? null;
      row.simple = binding?.simple ?? null;
      break;
    case 'secret_text':
    case 'json':
      break;
    default:
      for (const key of ['bucket_name', 'database_id', 'namespace_id', 'service', 'class_name', 'index_name']) {
        if (binding?.[key] != null) row[key] = binding[key];
      }
  }
  return row;
}

function safeDnsRecord(record) {
  const publicContentTypes = new Set(['A', 'AAAA', 'CNAME', 'NS', 'MX', 'CAA']);
  return {
    id: record?.id ?? null,
    name: record?.name ?? null,
    type: record?.type ?? null,
    content: publicContentTypes.has(record?.type) ? record?.content ?? null : '[redacted]',
    proxied: record?.proxied ?? null,
    ttl: record?.ttl ?? null,
  };
}

// Firewall expressions describe hostnames, paths and methods, none of which are
// secret, but an expression could in principle compare against a header value.
// Long opaque runs are masked so an inventory can never become an exfiltration
// channel, while the routing shape stays readable.
function safeExpression(value) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/"[A-Za-z0-9+/_=-]{24,}"/g, '"[redacted]"')
    .slice(0, 2000);
}

function selectorKinds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => Object.keys(entry ?? {})))].sort();
}

function safePageVariables(config) {
  const variables = config?.env_vars ?? {};
  return Object.entries(variables)
    .map(([name, value]) => ({ name, type: value?.type ?? 'unknown' }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function safeDeploymentAnnotations(annotations) {
  if (!annotations || typeof annotations !== 'object') return null;
  const allowed = ['workers/message', 'workers/tag', 'workers/triggered_by'];
  return Object.fromEntries(allowed.filter((key) => annotations[key] != null).map((key) => [key, annotations[key]]));
}

function safeRedirectTarget(value) {
  if (!value) return null;
  try {
    const target = new URL(value);
    return `${target.origin}${target.pathname}`;
  } catch {
    return '[invalid]';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  const zoneName = process.env.CLOUDFLARE_ZONE || 'vishartattoo.com';
  const sourceSha = process.env.SOURCE_SHA || '';

  if (!/^[0-9a-f]{32}$/.test(accountId)) fail('CLOUDFLARE_ACCOUNT_ID is missing or malformed');
  if (!token) fail('CLOUDFLARE_API_TOKEN is missing');
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail('SOURCE_SHA is missing or malformed');
  if (zoneName !== 'vishartattoo.com') fail('Refusing a non-production Cloudflare zone');

  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const reads = [];

  async function read(path, { required = true } = {}) {
    const response = await fetch(`${API_ROOT}${path}`, { method: 'GET', headers: auth });
    const status = response.status;
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    reads.push({ path, status });
    if (!response.ok || body?.success !== true) {
      const errorCodes = (body?.errors ?? [])
        .map((error) => Number(error?.code))
        .filter(Number.isFinite)
        .slice(0, 5);
      if (required) {
        fail(`Cloudflare read failed (${status}; codes=${errorCodes.join(',') || 'none'}) for ${path}`);
      }
      return { status, result: null };
    }
    return { status, result: body.result ?? null, result_info: body.result_info ?? null };
  }

  const tokenState = await read('/user/tokens/verify');
  if (tokenState.result?.status !== 'active') fail('Cloudflare API token is not active');

  const zoneRows = await read(`/zones?name=${encodeURIComponent(zoneName)}&per_page=50`);
  const exactZones = listRows(zoneRows.result, 'zones', ['zones'])
    .filter((zone) => zone?.name === zoneName);
  if (exactZones.length !== 1) fail('Exact production zone could not be resolved uniquely');
  const zone = exactZones[0];

  const [scriptRows, customDomainRows, routeRows, dnsRows, accountAccessRows, zoneAccessRows, pagesRows, kvRows, d1Rows, r2Rows, durableRows, queueRows] = await Promise.all([
    read(`/accounts/${accountId}/workers/scripts?per_page=100`),
    read(`/accounts/${accountId}/workers/domains?per_page=100`),
    read(`/zones/${zone.id}/workers/routes?per_page=100`),
    read(`/zones/${zone.id}/dns_records?per_page=500`),
    read(`/accounts/${accountId}/access/apps?per_page=100`, { required: false }),
    read(`/zones/${zone.id}/access/apps?per_page=100`, { required: false }),
    read(`/accounts/${accountId}/pages/projects`),
    read(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`, { required: false }),
    read(`/accounts/${accountId}/d1/database?per_page=100`, { required: false }),
    read(`/accounts/${accountId}/r2/buckets`, { required: false }),
    read(`/accounts/${accountId}/workers/durable_objects/namespaces`, { required: false }),
    read(`/accounts/${accountId}/queues?per_page=100`, { required: false }),
  ]);

  // Zone firewall rulesets decide whether a request reaches Access at all, so
  // an edge boundary review that stops at Access is incomplete.
  const rulesetRows = await read(`/zones/${zone.id}/rulesets`, { required: false });
  const firewallRulesets = [];
  for (const ruleset of listRows(rulesetRows.result, 'zone rulesets', ['rulesets'])) {
    const phase = String(ruleset?.phase || '');
    if (!/^http_(request_firewall_custom|ratelimit|request_sanitize)$/.test(phase)) continue;
    if (typeof ruleset?.id !== 'string') continue;
    const detail = await read(`/zones/${zone.id}/rulesets/${ruleset.id}`, { required: false });
    const rules = Array.isArray(detail.result?.rules) ? detail.result.rules : [];
    firewallRulesets.push({
      id: ruleset.id,
      name: ruleset.name ?? null,
      phase,
      kind: ruleset.kind ?? null,
      rules: rules.map((rule) => ({
        id: rule?.id ?? null,
        action: rule?.action ?? null,
        enabled: rule?.enabled ?? null,
        description: rule?.description ?? null,
        expression: safeExpression(rule?.expression),
      })),
    });
  }

  if (accountAccessRows.result == null && zoneAccessRows.result == null) {
    fail('Cloudflare Access applications are unreadable at both account and zone scope');
  }

  const scripts = sortBy(listRows(scriptRows.result, 'Workers', ['scripts']), 'id');
  const workers = [];
  for (const script of scripts) {
    const name = script.id;
    const [settings, deployments, schedules, subdomain, secrets] = await Promise.all([
      read(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`),
      read(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/deployments`),
      read(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/schedules`),
      read(`/accounts/${accountId}/workers/services/${encodeURIComponent(name)}/environments/production/subdomain`, { required: false }),
      read(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/secrets`, { required: false }),
    ]);
    const deploymentRows = listRows(deployments.result, 'Worker deployments', ['deployments']);
    const activeDeployment = deploymentRows[0] ?? null;
    const bindings = sortBy(listRows(settings.result?.bindings, 'Worker bindings').map(safeBinding), 'name');
    const secretRows = listRows(secrets.result, 'Worker secrets', ['secrets']);
    const secretNames = new Set([
      ...bindings.filter((binding) => binding.type === 'secret_text').map((binding) => binding.name),
      ...(secretRows.map((secret) => secret?.name).filter(Boolean)),
    ]);
    workers.push({
      name,
      vishar_named: VISHAR_NAME.test(name),
      created_on: script.created_on ?? null,
      modified_on: script.modified_on ?? null,
      compatibility_date: settings.result?.compatibility_date ?? null,
      compatibility_flags: settings.result?.compatibility_flags ?? [],
      usage_model: settings.result?.usage_model ?? null,
      observability: settings.result?.observability ?? null,
      logpush: settings.result?.logpush ?? null,
      tail_consumers: settings.result?.tail_consumers ?? [],
      placement: settings.result?.placement ?? null,
      bindings: bindings.filter((binding) => binding.type !== 'secret_text'),
      secret_names: [...secretNames].sort(),
      cron_triggers: sortBy(listRows(schedules.result, 'Worker schedules', ['schedules']), 'cron'),
      workers_dev_enabled: subdomain.result?.enabled ?? null,
      preview_urls_enabled: subdomain.result?.previews_enabled ?? null,
      active_deployment: activeDeployment ? {
        id: activeDeployment.id ?? null,
        created_on: activeDeployment.created_on ?? null,
        source: activeDeployment.source ?? null,
        versions: (activeDeployment.versions ?? []).map((version) => ({
          version_id: version.version_id ?? null,
          percentage: version.percentage ?? null,
        })),
        annotations: safeDeploymentAnnotations(activeDeployment.annotations),
      } : null,
    });
  }

  const accessApplications = [];
  const accessCandidates = [
    ...listRows(accountAccessRows.result, 'account Access applications', ['apps'])
      .map((app) => ({ app, scope_kind: 'accounts', scope_id: accountId })),
    ...listRows(zoneAccessRows.result, 'zone Access applications', ['apps'])
      .map((app) => ({ app, scope_kind: 'zones', scope_id: zone.id })),
  ];
  const seenAccessApps = new Set();
  for (const candidate of accessCandidates.sort((left, right) => String(left.app?.domain ?? '').localeCompare(String(right.app?.domain ?? '')))) {
    const { app, scope_kind: scopeKind, scope_id: scopeId } = candidate;
    const identity = app?.id || `${app?.domain ?? ''}:${app?.name ?? ''}`;
    if (seenAccessApps.has(identity)) continue;
    seenAccessApps.add(identity);
    const policies = await read(`/${scopeKind}/${scopeId}/access/apps/${app.id}/policies?per_page=100`, { required: false });
    const policyRows = listRows(policies.result, 'Access policies', ['policies']);
    accessApplications.push({
      id: app.id ?? null,
      name: app.name ?? null,
      domain: app.domain ?? null,
      type: app.type ?? null,
      scope_kind: scopeKind,
      session_duration: app.session_duration ?? null,
      app_launcher_visible: app.app_launcher_visible ?? null,
      policies: sortBy(policyRows.map((policy) => ({
        id: policy.id ?? null,
        name: policy.name ?? null,
        decision: policy.decision ?? null,
        precedence: policy.precedence ?? null,
        include_selector_kinds: selectorKinds(policy.include),
        exclude_selector_kinds: selectorKinds(policy.exclude),
        require_selector_kinds: selectorKinds(policy.require),
      })), 'precedence'),
    });
  }

  const httpBoundaries = await Promise.all(HTTP_BOUNDARIES.map(async (url) => {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.1' },
        signal: AbortSignal.timeout(10_000),
      });
      return {
        url,
        status: response.status,
        redirect_target: safeRedirectTarget(response.headers.get('location')),
      };
    } catch {
      return { url, status: null, redirect_target: null, error: 'request_failed' };
    }
  }));

  const pages = [];
  for (const project of sortBy(listRows(pagesRows.result, 'Pages projects', ['projects']), 'name')) {
    const deployments = await read(`/accounts/${accountId}/pages/projects/${encodeURIComponent(project.name)}/deployments`);
    const production = listRows(deployments.result, 'Pages deployments', ['deployments'])
      .find((deployment) => deployment?.environment === 'production') ?? null;
    pages.push({
      name: project.name,
      vishar_named: VISHAR_NAME.test(project.name),
      subdomain: project.subdomain ?? null,
      domains: [...(project.domains ?? [])].sort(),
      production_branch: project.production_branch ?? null,
      created_on: project.created_on ?? null,
      source_type: project.source?.type ?? null,
      production_variable_names: safePageVariables(project.deployment_configs?.production),
      preview_variable_names: safePageVariables(project.deployment_configs?.preview),
      latest_production_deployment: production ? {
        id: production.id ?? null,
        url: production.url ?? null,
        created_on: production.created_on ?? null,
        aliases: production.aliases ?? [],
        commit_hash: production.deployment_trigger?.metadata?.commit_hash ?? null,
        branch: production.deployment_trigger?.metadata?.branch ?? null,
        source: production.source ?? null,
        functions_presence: production.functions != null ? Boolean(production.functions) : 'not_reported_by_api',
      } : null,
    });
  }

  const inventory = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    source_sha: sourceSha,
    account_id: accountId,
    zone: { id: zone.id, name: zone.name, status: zone.status, paused: zone.paused, type: zone.type },
    workers,
    worker_custom_domains: sortBy(listRows(customDomainRows.result, 'Worker Custom Domains', ['domains']).map((domain) => ({
      id: domain.id ?? null,
      hostname: domain.hostname ?? null,
      service: domain.service ?? domain.worker_name ?? null,
      environment: domain.environment ?? null,
      zone_id: domain.zone_id ?? null,
      zone_name: domain.zone_name ?? null,
      enabled: domain.enabled ?? null,
      previews_enabled: domain.previews_enabled ?? null,
    })), 'hostname'),
    worker_routes: sortBy(listRows(routeRows.result, 'Worker routes', ['routes']).map((route) => ({
      id: route.id ?? null,
      pattern: route.pattern ?? null,
      script: route.script ?? null,
    })), 'pattern'),
    dns_records: sortBy(listRows(dnsRows.result, 'DNS records', ['records']).map(safeDnsRecord), 'name'),
    access_applications: accessApplications,
    firewall_rulesets: firewallRulesets,
    http_boundaries: httpBoundaries,
    pages,
    storage: {
      kv_status: kvRows.status,
      kv_namespaces: sortBy(listRows(kvRows.result, 'KV namespaces', ['namespaces']).map((row) => ({ id: row.id ?? null, title: row.title ?? null })), 'title'),
      d1_status: d1Rows.status,
      d1_databases: sortBy(listRows(d1Rows.result, 'D1 databases', ['databases', 'result']).map((row) => ({ uuid: row.uuid ?? null, name: row.name ?? null })), 'name'),
      r2_status: r2Rows.status,
      r2_buckets: sortBy(listRows(r2Rows.result, 'R2 buckets', ['buckets']).map((row) => ({ name: row.name ?? null, creation_date: row.creation_date ?? null })), 'name'),
      durable_objects_status: durableRows.status,
      durable_object_namespaces: sortBy(listRows(durableRows.result, 'Durable Object namespaces', ['namespaces']).map((row) => ({ id: row.id ?? null, name: row.name ?? null, script: row.script ?? null, class: row.class ?? null })), 'name'),
      queues_status: queueRows.status,
      queues: sortBy(listRows(queueRows.result, 'Queues', ['queues']).map((row) => ({ queue_id: row.queue_id ?? row.id ?? null, queue_name: row.queue_name ?? row.name ?? null })), 'queue_name'),
    },
    read_statuses: reads.map(({ path, status }) => ({ path, status })),
  };

  const outputPath = resolve(args.output);
  const summaryPath = resolve(args.summary);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });

  const summary = [
    '### Cloudflare production inventory',
    '',
    `- Exact source SHA: \`${sourceSha}\``,
    `- Zone: \`${zone.name}\` (${zone.status})`,
    `- Account Workers: ${workers.length} (${workers.filter((worker) => worker.vishar_named).length} Vishar-named)`,
    `- Worker Custom Domains: ${inventory.worker_custom_domains.length}`,
    `- Worker Routes: ${inventory.worker_routes.length}`,
    `- Pages projects: ${pages.length} (${pages.filter((project) => project.vishar_named).length} Vishar-named)`,
    `- Access applications: ${accessApplications.length} (account and zone scopes reconciled)`,
    `- Firewall rulesets: ${firewallRulesets.length} (${firewallRulesets.reduce((total, set) => total + set.rules.length, 0)} rules)`,
    ...firewallRulesets.flatMap((set) => [
      '',
      `  \`${set.phase}\` / \`${set.name ?? set.id}\``,
      ...set.rules.map((rule) => `  - \`${rule.action}\`${rule.enabled === false ? ' (disabled)' : ''} ${rule.description ?? ''}\n    \`${rule.expression ?? ''}\``),
    ]),
    `- Unauthenticated HTTP boundaries: ${httpBoundaries.length}`,
    `- DNS records inventoried: ${inventory.dns_records.length} (TXT and non-routing content redacted)`,
    '- Cloudflare mutations: none (GET requests only)',
    '- Secret values: never requested; secret names only',
    '',
  ].join('\n');
  await writeFile(summaryPath, summary, { mode: 0o600 });
  process.stdout.write(`workers=${workers.length} pages=${pages.length} domains=${inventory.worker_custom_domains.length} routes=${inventory.worker_routes.length}\n`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});