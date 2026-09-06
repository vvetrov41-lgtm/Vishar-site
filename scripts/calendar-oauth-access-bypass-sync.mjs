#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
export const CALENDAR_HOST = 'calendar.vishartattoo.com';
export const ROOT_DOMAIN = CALENDAR_HOST;
export const START_DOMAIN = `${CALENDAR_HOST}/oauth/google/start/*`;
export const CALLBACK_DOMAIN = `${CALENDAR_HOST}/oauth/google/callback`;
const TARGETS = [
  { key: 'start', domain: START_DOMAIN, appName: 'Vishar Calendar public OAuth start', policyName: 'Bypass Calendar OAuth start' },
  { key: 'callback', domain: CALLBACK_DOMAIN, appName: 'Vishar Calendar public OAuth callback', policyName: 'Bypass Calendar OAuth callback' },
];

function fail(message) {
  throw new Error(message);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedDomain(value) {
  return String(value || '').trim().replace(/^https:\/\//i, '').replace(/\/$/, '').toLowerCase();
}

function policyShape(policy) {
  return {
    decision: policy?.decision,
    precedence: policy?.precedence,
    include: policy?.include,
    exclude: policy?.exclude,
    require: policy?.require,
  };
}

export function isExactBypassEveryone(policy) {
  if (!policy || policy.decision !== 'bypass') return false;
  if (!Array.isArray(policy.include) || policy.include.length !== 1) return false;
  if (Array.isArray(policy.exclude) && policy.exclude.length !== 0) return false;
  if (Array.isArray(policy.require) && policy.require.length !== 0) return false;
  const rule = policy.include[0];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  const keys = Object.keys(rule);
  if (keys.length !== 1 || keys[0] !== 'everyone') return false;
  const everyone = rule.everyone;
  return everyone && typeof everyone === 'object' && !Array.isArray(everyone) && Object.keys(everyone).length === 0;
}

export function bypassPolicyPayload(name) {
  if (typeof name !== 'string' || !name.trim()) fail('bypass_policy_name_invalid');
  return {
    name: name.trim(),
    decision: 'bypass',
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  };
}

export function bypassApplicationPayload(name, domain) {
  if (typeof name !== 'string' || !name.trim()) fail('bypass_app_name_invalid');
  if (![START_DOMAIN, CALLBACK_DOMAIN].includes(domain)) fail('bypass_domain_not_allowlisted');
  return {
    name: name.trim(),
    type: 'self_hosted',
    domain,
    app_launcher_visible: false,
  };
}

function rootAppFingerprint(app, policies) {
  if (!app || normalizedDomain(app.domain) !== ROOT_DOMAIN) fail('calendar_root_access_app_invalid');
  if (!Array.isArray(policies) || policies.length < 1) fail('calendar_root_access_policy_missing');
  if (policies.some((policy) => policy?.decision === 'bypass')) fail('calendar_root_access_must_not_bypass');
  return digest({
    id: app.id,
    domain: normalizedDomain(app.domain),
    type: app.type,
    policies: policies.map(policyShape),
  });
}

function safeTargetState(target, app, policies) {
  if (!app) return { key: target.key, domain: target.domain, exists: false, bypass_everyone: false, policy_count: 0 };
  if (normalizedDomain(app.domain) !== target.domain) fail(`calendar_${target.key}_app_domain_invalid`);
  if (app.type !== 'self_hosted') fail(`calendar_${target.key}_app_type_invalid`);
  if (!Array.isArray(policies)) fail(`calendar_${target.key}_policies_invalid`);
  return {
    key: target.key,
    domain: target.domain,
    exists: true,
    bypass_everyone: policies.length === 1 && isExactBypassEveryone(policies[0]),
    policy_count: policies.length,
  };
}

function createClient({ accountId, token, fetchImpl = fetch }) {
  if (!/^[0-9a-f]{32}$/i.test(accountId || '')) fail('cloudflare_account_id_invalid');
  if (typeof token !== 'string' || token.trim().length < 20) fail('cloudflare_api_token_missing');

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      const code = Array.isArray(payload?.errors) && payload.errors[0]?.code != null
        ? String(payload.errors[0].code).slice(0, 40)
        : 'unknown';
      fail(`cloudflare_api_failed:${method}:${response.status}:${code}`);
    }
    return payload.result;
  }

  async function listApps() {
    const result = await api(`/accounts/${accountId}/access/apps?per_page=100`);
    return Array.isArray(result) ? result : [];
  }

  async function policiesFor(appId) {
    const result = await api(`/accounts/${accountId}/access/apps/${appId}/policies?per_page=100`);
    return Array.isArray(result) ? result : [];
  }

  async function read() {
    const apps = await listApps();
    const matchesFor = (domain) => apps.filter((app) => normalizedDomain(app?.domain) === domain);
    const rootMatches = matchesFor(ROOT_DOMAIN);
    if (rootMatches.length !== 1 || typeof rootMatches[0]?.id !== 'string') fail('calendar_root_access_app_not_unique');
    const rootPolicies = await policiesFor(rootMatches[0].id);
    const rootFingerprint = rootAppFingerprint(rootMatches[0], rootPolicies);

    const targets = {};
    for (const target of TARGETS) {
      const matches = matchesFor(target.domain);
      if (matches.length > 1) fail(`calendar_${target.key}_access_app_not_unique`);
      if (matches.length === 0) {
        targets[target.key] = { target, app: null, policies: [] };
        continue;
      }
      if (typeof matches[0]?.id !== 'string') fail(`calendar_${target.key}_access_app_id_missing`);
      targets[target.key] = { target, app: matches[0], policies: await policiesFor(matches[0].id) };
    }
    return { rootFingerprint, targets };
  }

  async function createApp(target) {
    return api(`/accounts/${accountId}/access/apps`, {
      method: 'POST',
      body: bypassApplicationPayload(target.appName, target.domain),
    });
  }

  async function createPolicy(appId, target) {
    return api(`/accounts/${accountId}/access/apps/${appId}/policies`, {
      method: 'POST',
      body: bypassPolicyPayload(target.policyName),
    });
  }

  async function deleteApp(appId) {
    await api(`/accounts/${accountId}/access/apps/${appId}`, { method: 'DELETE' });
  }

  return { read, createApp, createPolicy, deleteApp };
}

function safeState(readState) {
  const targetStates = TARGETS.map((target) => {
    const row = readState.targets[target.key];
    return safeTargetState(target, row.app, row.policies);
  });
  return {
    host: CALENDAR_HOST,
    root_access_fingerprint: readState.rootFingerprint,
    public_paths: targetStates,
    in_sync: targetStates.every((row) => row.exists && row.bypass_everyone && row.policy_count === 1),
  };
}

export async function inspectCalendarOAuthAccess(options) {
  const client = createClient(options);
  return safeState(await client.read());
}

export async function syncCalendarOAuthAccess(options) {
  const client = createClient(options);
  const beforeRead = await client.read();
  const before = safeState(beforeRead);
  if (before.in_sync) return { before, after: before, changed: false };

  for (const target of TARGETS) {
    const row = beforeRead.targets[target.key];
    if (row.app && !(row.policies.length === 1 && isExactBypassEveryone(row.policies[0]))) {
      fail(`calendar_${target.key}_existing_app_not_exact_bypass`);
    }
  }

  const created = [];
  try {
    for (const target of TARGETS) {
      const row = beforeRead.targets[target.key];
      if (row.app) continue;
      const app = await client.createApp(target);
      if (!app || typeof app.id !== 'string' || normalizedDomain(app.domain) !== target.domain) {
        fail(`calendar_${target.key}_created_app_invalid`);
      }
      created.push(app.id);
      const policy = await client.createPolicy(app.id, target);
      if (!policy || typeof policy.id !== 'string' || !isExactBypassEveryone(policy)) {
        fail(`calendar_${target.key}_created_policy_invalid`);
      }
    }

    const afterRead = await client.read();
    const after = safeState(afterRead);
    if (!after.in_sync) fail('calendar_oauth_access_readback_mismatch');
    if (after.root_access_fingerprint !== before.root_access_fingerprint) {
      fail('calendar_root_access_changed_during_oauth_bypass_sync');
    }
    return { before, after, changed: created.length > 0 };
  } catch (error) {
    for (const appId of created.reverse()) {
      try { await client.deleteApp(appId); } catch { /* rollback best effort, verified below */ }
    }
    try {
      const rollback = safeState(await client.read());
      if (rollback.root_access_fingerprint !== before.root_access_fingerprint) {
        fail('calendar_oauth_access_rollback_root_mismatch');
      }
      const lingering = rollback.public_paths.some((row) => !before.public_paths.find((old) => old.key === row.key)?.exists && row.exists);
      if (lingering) fail('calendar_oauth_access_rollback_incomplete');
    } catch {
      fail('calendar_oauth_access_sync_failed_rollback_failed');
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || '';
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : '';
  if (!['inspect', 'sync'].includes(mode)) fail('usage: calendar-oauth-access-bypass-sync.mjs <inspect|sync> --output <path>');
  if (!output) fail('output_path_required');

  const options = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    token: process.env.CLOUDFLARE_API_TOKEN || '',
  };
  const result = mode === 'sync'
    ? await syncCalendarOAuthAccess(options)
    : await inspectCalendarOAuthAccess(options);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const summary = mode === 'sync' ? result.after : result;
  console.log(`Calendar OAuth Access ${mode}: public paths=${summary.public_paths.filter((row) => row.bypass_everyone).length}/2, in_sync=${summary.in_sync}${mode === 'sync' ? `, changed=${result.changed}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'calendar_oauth_access_sync_failed');
    process.exitCode = 1;
  });
}
