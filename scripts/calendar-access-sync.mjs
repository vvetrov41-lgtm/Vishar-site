#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const SOURCE_HOST = 'app.vishartattoo.com';
const TARGET_HOST = 'calendar.vishartattoo.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function fail(message) {
  throw new Error(message);
}

function exactEmailRules(policy, label) {
  if (!policy || policy.decision !== 'allow') fail(`${label}_policy_must_be_allow`);
  if (!Array.isArray(policy.include) || policy.include.length === 0) fail(`${label}_policy_has_no_email_rules`);
  if (Array.isArray(policy.exclude) && policy.exclude.length) fail(`${label}_policy_has_exclusions`);
  if (Array.isArray(policy.require) && policy.require.length) fail(`${label}_policy_has_requirements`);

  const emails = [];
  for (const rule of policy.include) {
    const keys = rule && typeof rule === 'object' && !Array.isArray(rule) ? Object.keys(rule) : [];
    if (keys.length !== 1 || keys[0] !== 'email') fail(`${label}_policy_is_not_email_only`);
    const emailBlock = rule.email;
    const emailKeys = emailBlock && typeof emailBlock === 'object' && !Array.isArray(emailBlock)
      ? Object.keys(emailBlock)
      : [];
    if (emailKeys.length !== 1 || emailKeys[0] !== 'email') fail(`${label}_policy_email_rule_shape_invalid`);
    const email = String(emailBlock.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) fail(`${label}_policy_email_invalid`);
    emails.push(email);
  }
  const unique = [...new Set(emails)].sort();
  if (unique.length !== emails.length) fail(`${label}_policy_has_duplicate_email_rules`);
  return unique;
}

export function policyFingerprint(policy, label = 'policy') {
  const emails = exactEmailRules(policy, label);
  const digest = createHash('sha256').update(JSON.stringify(emails)).digest('hex');
  return { count: emails.length, digest };
}

function updatePayload(policy) {
  exactEmailRules(policy, 'source');
  const payload = {
    name: 'Owner and named staff only',
    decision: 'allow',
    precedence: Number.isInteger(policy.precedence) ? policy.precedence : 1,
    include: policy.include,
    exclude: [],
    require: [],
  };
  if (typeof policy.session_duration === 'string' && policy.session_duration) {
    payload.session_duration = policy.session_duration;
  }
  return payload;
}

function safeState(source, target) {
  const sourceFp = policyFingerprint(source, 'source');
  const targetFp = policyFingerprint(target, 'target');
  return {
    source_host: SOURCE_HOST,
    target_host: TARGET_HOST,
    source_email_rule_count: sourceFp.count,
    target_email_rule_count: targetFp.count,
    source_policy_digest: sourceFp.digest,
    target_policy_digest: targetFp.digest,
    in_sync: sourceFp.digest === targetFp.digest,
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

  async function appFor(host) {
    const rows = await api(`/accounts/${accountId}/access/apps?per_page=100`);
    const matches = (Array.isArray(rows) ? rows : []).filter((app) =>
      String(app?.domain || '').replace(/\/$/, '').toLowerCase() === host);
    if (matches.length !== 1 || typeof matches[0]?.id !== 'string') fail(`access_app_not_unique:${host}`);
    return matches[0];
  }

  async function policyFor(app, label) {
    const rows = await api(`/accounts/${accountId}/access/apps/${app.id}/policies?per_page=100`);
    const policies = Array.isArray(rows) ? rows : [];
    if (policies.length !== 1 || typeof policies[0]?.id !== 'string') fail(`${label}_policy_not_unique`);
    exactEmailRules(policies[0], label);
    return policies[0];
  }

  async function read() {
    const [sourceApp, targetApp] = await Promise.all([appFor(SOURCE_HOST), appFor(TARGET_HOST)]);
    const [sourcePolicy, targetPolicy] = await Promise.all([
      policyFor(sourceApp, 'source'),
      policyFor(targetApp, 'target'),
    ]);
    return { sourceApp, targetApp, sourcePolicy, targetPolicy };
  }

  async function putPolicy(appId, policyId, payload) {
    return api(`/accounts/${accountId}/access/apps/${appId}/policies/${policyId}`, {
      method: 'PUT',
      body: payload,
    });
  }

  return { read, putPolicy };
}

export async function inspectCalendarAccess(options) {
  const client = createClient(options);
  const state = await client.read();
  return safeState(state.sourcePolicy, state.targetPolicy);
}

export async function syncCalendarAccess(options) {
  const client = createClient(options);
  const before = await client.read();
  const beforeSafe = safeState(before.sourcePolicy, before.targetPolicy);
  if (beforeSafe.in_sync) return { before: beforeSafe, after: beforeSafe, changed: false };

  const originalTargetPayload = {
    name: before.targetPolicy.name || 'Vishar Calendar production owner only',
    decision: before.targetPolicy.decision,
    precedence: Number.isInteger(before.targetPolicy.precedence) ? before.targetPolicy.precedence : 1,
    include: before.targetPolicy.include,
    exclude: Array.isArray(before.targetPolicy.exclude) ? before.targetPolicy.exclude : [],
    require: Array.isArray(before.targetPolicy.require) ? before.targetPolicy.require : [],
    ...(typeof before.targetPolicy.session_duration === 'string' && before.targetPolicy.session_duration
      ? { session_duration: before.targetPolicy.session_duration }
      : {}),
  };

  let mutated = false;
  try {
    await client.putPolicy(before.targetApp.id, before.targetPolicy.id, updatePayload(before.sourcePolicy));
    mutated = true;
    const after = await client.read();
    const afterSafe = safeState(after.sourcePolicy, after.targetPolicy);
    if (!afterSafe.in_sync) fail('calendar_access_readback_mismatch');
    return { before: beforeSafe, after: afterSafe, changed: true };
  } catch (error) {
    if (mutated) {
      try {
        await client.putPolicy(before.targetApp.id, before.targetPolicy.id, originalTargetPayload);
        const rollback = await client.read();
        const rollbackFp = policyFingerprint(rollback.targetPolicy, 'target');
        const originalFp = policyFingerprint(before.targetPolicy, 'target');
        if (rollbackFp.digest !== originalFp.digest) fail('calendar_access_rollback_readback_mismatch');
      } catch {
        fail('calendar_access_sync_failed_rollback_failed');
      }
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || '';
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : '';
  if (!['inspect', 'sync'].includes(mode)) fail('usage: calendar-access-sync.mjs <inspect|sync> --output <path>');
  if (!output) fail('output_path_required');

  const options = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    token: process.env.CLOUDFLARE_API_TOKEN || '',
  };
  const result = mode === 'sync'
    ? await syncCalendarAccess(options)
    : await inspectCalendarAccess(options);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const summary = mode === 'sync' ? result.after : result;
  console.log(`Calendar Access ${mode}: source rules=${summary.source_email_rule_count}, target rules=${summary.target_email_rule_count}, in_sync=${summary.in_sync}${mode === 'sync' ? `, changed=${result.changed}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'calendar_access_sync_failed');
    process.exitCode = 1;
  });
}
