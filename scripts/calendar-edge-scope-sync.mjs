#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = 'vishartattoo.com';
const CALENDAR_HOST = 'calendar.vishartattoo.com';
// The rule is a legacy zone firewall rule, not a ruleset rule: the production
// inventory reads /zones/{id}/firewall/rules successfully and still gets 403
// from /zones/{id}/rulesets, and the Calendar boundary is one of the four rules
// the former returns. The expression lives on the rule's filter, so that is
// what gets rewritten.
const SOURCE = 'zone_legacy_firewall_rule';

// A slug or UUID sitting after start/ or disconnect/ is per-artist enumeration.
// The closing quote in a prefix literal is what separates "/oauth/google/start/"
// from "/oauth/google/start/vladimir".
const ARTIST_ENUMERATION = /\/oauth\/google\/(?:start|disconnect)\/[^"'\s)]+/i;

function fail(message) {
  throw new Error(message);
}

function digestOf(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// Everything the live rule allows other than the two artist slugs is kept
// exactly as it is:
//
//   - /cdn-cgi/access/* is Cloudflare Access's own login and callback surface.
//     Dropping it would put the Access flow behind the block this rule applies,
//     which would break the connector for every artist including the two that
//     work today.
//   - the method scoping is unchanged: GET for health, callback and start,
//     GET or POST for disconnect, matching what the Worker actually serves.
//
// The single difference is that a reference under start/ and disconnect/ is now
// any reference rather than an enumerated one.
export function expectedExpression() {
  const expression = [
    `(http.host eq "${CALENDAR_HOST}" and not (`,
    '  starts_with(http.request.uri.path, "/cdn-cgi/access/") or',
    '  (http.request.method eq "GET" and (',
    '    http.request.uri.path eq "/health" or',
    '    http.request.uri.path eq "/oauth/google/callback" or',
    '    starts_with(http.request.uri.path, "/oauth/google/start/")',
    '  )) or',
    '  ((http.request.method eq "GET" or http.request.method eq "POST") and',
    '    starts_with(http.request.uri.path, "/oauth/google/disconnect/"))',
    '))',
  ].join('\n');
  // Self-check: the replacement must never reintroduce what it exists to remove.
  if (ARTIST_ENUMERATION.test(expression)) fail('expected_expression_enumerates_artists');
  if (!expression.includes('/cdn-cgi/access/')) fail('expected_expression_would_block_access');
  return expression;
}

export function enumeratesArtists(expression) {
  return ARTIST_ENUMERATION.test(String(expression ?? ''));
}

// Expressions describe hosts, paths and methods, but an expression could in
// principle compare against a header value, so long opaque runs are masked
// before anything is written to an artifact.
function safeExpression(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/"[A-Za-z0-9+/_=-]{32,}"/g, '"[redacted]"').slice(0, 900);
}

export function selectCalendarRule(rules) {
  if (!Array.isArray(rules) || rules.length === 0) fail('calendar_edge_ruleset_is_empty');
  const matches = rules.filter((rule) => String(rule?.filter?.expression ?? '').includes(CALENDAR_HOST));
  if (matches.length !== 1) fail(`calendar_edge_rule_not_unique:${matches.length}`);
  const rule = matches[0];
  if (typeof rule.id !== 'string' || rule.id.length < 8) fail('calendar_edge_rule_id_invalid');
  if (typeof rule.filter?.id !== 'string' || rule.filter.id.length < 8) fail('calendar_edge_filter_id_invalid');
  // Only a block rule is in scope. Anything else at this hostname was put there
  // for a reason this script does not know, so it is left alone.
  if (rule.action !== 'block') fail(`calendar_edge_rule_action_unsupported:${String(rule.action).slice(0, 24)}`);
  if (rule.paused === true) fail('calendar_edge_rule_is_disabled');
  return rule;
}

export function otherRulesDigest(rules, targetId) {
  const rest = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.id !== targetId)
    .map((rule) => [rule?.id ?? '', rule?.action ?? '', rule?.paused ?? '', rule?.filter?.expression ?? ''].join(' '))
    .sort();
  return digestOf(JSON.stringify(rest));
}

function safeState(rules, rule) {
  const expected = expectedExpression();
  const current = String(rule.filter?.expression ?? '');
  return {
    zone: ZONE_NAME,
    host: CALENDAR_HOST,
    source: SOURCE,
    rule_id: rule.id,
    filter_id: rule.filter.id,
    rule_action: rule.action,
    rule_count: rules.length,
    current_expression_digest: digestOf(current),
    expected_expression_digest: digestOf(expected),
    other_rules_digest: otherRulesDigest(rules, rule.id),
    enumerates_artists: enumeratesArtists(current),
    allows_access_endpoints: current.includes('/cdn-cgi/access/'),
    current_expression_preview: safeExpression(current),
    in_sync: current === expected,
  };
}

function createClient({ token, fetchImpl = fetch }) {
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

  async function zoneId() {
    const rows = await api(`/zones?name=${encodeURIComponent(ZONE_NAME)}&per_page=50`);
    const exact = (Array.isArray(rows) ? rows : []).filter((zone) => zone?.name === ZONE_NAME);
    if (exact.length !== 1 || typeof exact[0]?.id !== 'string') fail('production_zone_not_unique');
    return exact[0].id;
  }

  async function read() {
    const zone = await zoneId();
    const rows = await api(`/zones/${zone}/firewall/rules?per_page=100`);
    const rules = Array.isArray(rows) ? rows : [];
    return { zone, rules, rule: selectCalendarRule(rules) };
  }

  // The expression belongs to the filter, so the rule itself, its action, its
  // priority and its description are never sent and cannot be disturbed.
  async function putExpression(zone, rule, expression) {
    return api(`/zones/${zone}/filters/${rule.filter.id}`, {
      method: 'PUT',
      body: {
        id: rule.filter.id,
        expression,
        paused: rule.filter.paused === true,
        ...(typeof rule.filter.description === 'string' && rule.filter.description
          ? { description: rule.filter.description }
          : {}),
      },
    });
  }

  return { read, putExpression };
}

export async function inspectCalendarEdgeScope(options) {
  const client = createClient(options);
  const state = await client.read();
  return safeState(state.rules, state.rule);
}

export async function syncCalendarEdgeScope(options) {
  const client = createClient(options);
  const before = await client.read();
  const beforeSafe = safeState(before.rules, before.rule);
  if (beforeSafe.in_sync) return { before: beforeSafe, after: beforeSafe, changed: false };
  // Refuse to touch a boundary that does not currently exempt Access: that
  // would mean this rule is not the one this script was written against.
  if (!beforeSafe.allows_access_endpoints) fail('calendar_edge_rule_does_not_exempt_access');

  const originalExpression = String(before.rule.filter.expression ?? '');
  let mutated = false;
  try {
    await client.putExpression(before.zone, before.rule, expectedExpression());
    mutated = true;
    const after = await client.read();
    const afterSafe = safeState(after.rules, after.rule);
    if (!afterSafe.in_sync) fail('calendar_edge_readback_mismatch');
    if (afterSafe.enumerates_artists) fail('calendar_edge_still_enumerates_artists');
    if (!afterSafe.allows_access_endpoints) fail('calendar_edge_would_block_access');
    if (afterSafe.rule_id !== beforeSafe.rule_id) fail('calendar_edge_rule_identity_changed');
    if (afterSafe.filter_id !== beforeSafe.filter_id) fail('calendar_edge_filter_identity_changed');
    if (afterSafe.rule_action !== beforeSafe.rule_action) fail('calendar_edge_rule_action_changed');
    // Nothing outside the one Calendar rule may move, in either direction.
    if (afterSafe.other_rules_digest !== beforeSafe.other_rules_digest) fail('calendar_edge_collateral_rule_change');
    if (afterSafe.rule_count !== beforeSafe.rule_count) fail('calendar_edge_rule_count_changed');
    return { before: beforeSafe, after: afterSafe, changed: true };
  } catch (error) {
    if (mutated) {
      try {
        await client.putExpression(before.zone, before.rule, originalExpression);
        const rollback = await client.read();
        if (digestOf(String(rollback.rule.filter?.expression ?? '')) !== beforeSafe.current_expression_digest) {
          fail('calendar_edge_rollback_readback_mismatch');
        }
      } catch {
        fail('calendar_edge_sync_failed_rollback_failed');
      }
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || '';
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : '';
  if (!['inspect', 'sync'].includes(mode)) fail('usage: calendar-edge-scope-sync.mjs <inspect|sync> --output <path>');
  if (!output) fail('output_path_required');

  const options = { token: process.env.CLOUDFLARE_API_TOKEN || '' };
  const result = mode === 'sync'
    ? await syncCalendarEdgeScope(options)
    : await inspectCalendarEdgeScope(options);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const summary = mode === 'sync' ? result.after : result;
  console.log(`Calendar edge scope ${mode}: enumerates_artists=${summary.enumerates_artists}, access_exempt=${summary.allows_access_endpoints}, in_sync=${summary.in_sync}${mode === 'sync' ? `, changed=${result.changed}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'calendar_edge_scope_sync_failed');
    process.exitCode = 1;
  });
}
