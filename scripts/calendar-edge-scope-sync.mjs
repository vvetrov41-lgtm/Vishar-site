#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = 'vishartattoo.com';
const CALENDAR_HOST = 'calendar.vishartattoo.com';
const PHASE = 'http_request_firewall_custom';

// The Calendar Worker serves exactly four route shapes: /health,
// /oauth/google/callback, and one artist reference under start and disconnect.
// The edge rule may scope traffic to those shapes, but it must not know any
// artist, because that is the thing onboarding a new artist would have to edit.
const ALLOWED_EXACT_PATHS = Object.freeze(['/health', '/oauth/google/callback']);
const ALLOWED_PATH_PREFIXES = Object.freeze(['/oauth/google/start/', '/oauth/google/disconnect/']);

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

export function expectedExpression() {
  const clauses = [
    ...ALLOWED_EXACT_PATHS.map((path) => `http.request.uri.path eq "${path}"`),
    ...ALLOWED_PATH_PREFIXES.map((prefix) => `starts_with(http.request.uri.path, "${prefix}")`),
  ];
  const expression = `(http.host eq "${CALENDAR_HOST}" and not (${clauses.join(' or ')}))`;
  // Self-check: the replacement must never reintroduce what it exists to remove.
  if (ARTIST_ENUMERATION.test(expression)) fail('expected_expression_enumerates_artists');
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
  return value.replace(/"[A-Za-z0-9+/_=-]{32,}"/g, '"[redacted]"').slice(0, 600);
}

export function selectCalendarRule(rules) {
  if (!Array.isArray(rules) || rules.length === 0) fail('calendar_edge_ruleset_is_empty');
  const matches = rules.filter((rule) => String(rule?.expression ?? '').includes(CALENDAR_HOST));
  if (matches.length !== 1) fail(`calendar_edge_rule_not_unique:${matches.length}`);
  const rule = matches[0];
  if (typeof rule.id !== 'string' || rule.id.length < 8) fail('calendar_edge_rule_id_invalid');
  // Only a block rule is in scope. Anything else at this hostname was put there
  // for a reason this script does not know, so it is left alone.
  if (rule.action !== 'block') fail(`calendar_edge_rule_action_unsupported:${String(rule.action).slice(0, 24)}`);
  if (rule.enabled === false) fail('calendar_edge_rule_is_disabled');
  return rule;
}

export function otherRulesDigest(rules, targetId) {
  const rest = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.id !== targetId)
    .map((rule) => [rule?.id ?? '', rule?.action ?? '', rule?.enabled ?? '', rule?.expression ?? ''].join(' '));
  return digestOf(JSON.stringify(rest));
}

function safeState(rules, rule) {
  const expected = expectedExpression();
  const current = String(rule.expression ?? '');
  return {
    zone: ZONE_NAME,
    host: CALENDAR_HOST,
    phase: PHASE,
    rule_id: rule.id,
    rule_action: rule.action,
    rule_count: rules.length,
    current_expression_digest: digestOf(current),
    expected_expression_digest: digestOf(expected),
    other_rules_digest: otherRulesDigest(rules, rule.id),
    enumerates_artists: enumeratesArtists(current),
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
    const rows = await api(`/zones/${zone}/rulesets`);
    const entrypoints = (Array.isArray(rows) ? rows : [])
      .filter((ruleset) => ruleset?.phase === PHASE && ruleset?.kind === 'zone');
    if (entrypoints.length !== 1 || typeof entrypoints[0]?.id !== 'string') fail('custom_firewall_entrypoint_not_unique');
    const rulesetId = entrypoints[0].id;
    const detail = await api(`/zones/${zone}/rulesets/${rulesetId}`);
    const rules = Array.isArray(detail?.rules) ? detail.rules : [];
    return { zone, rulesetId, rules, rule: selectCalendarRule(rules) };
  }

  async function patchRule(zone, rulesetId, rule, expression) {
    return api(`/zones/${zone}/rulesets/${rulesetId}/rules/${rule.id}`, {
      method: 'PATCH',
      body: {
        action: 'block',
        enabled: true,
        expression,
        ...(typeof rule.description === 'string' && rule.description ? { description: rule.description } : {}),
      },
    });
  }

  return { read, patchRule };
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

  const originalExpression = String(before.rule.expression ?? '');
  let mutated = false;
  try {
    await client.patchRule(before.zone, before.rulesetId, before.rule, expectedExpression());
    mutated = true;
    const after = await client.read();
    const afterSafe = safeState(after.rules, after.rule);
    if (!afterSafe.in_sync) fail('calendar_edge_readback_mismatch');
    if (afterSafe.enumerates_artists) fail('calendar_edge_still_enumerates_artists');
    if (afterSafe.rule_id !== beforeSafe.rule_id) fail('calendar_edge_rule_identity_changed');
    // Nothing outside the one Calendar rule may move, in either direction.
    if (afterSafe.other_rules_digest !== beforeSafe.other_rules_digest) fail('calendar_edge_collateral_rule_change');
    if (afterSafe.rule_count !== beforeSafe.rule_count) fail('calendar_edge_rule_count_changed');
    return { before: beforeSafe, after: afterSafe, changed: true };
  } catch (error) {
    if (mutated) {
      try {
        await client.patchRule(before.zone, before.rulesetId, before.rule, originalExpression);
        const rollback = await client.read();
        if (digestOf(String(rollback.rule.expression ?? '')) !== beforeSafe.current_expression_digest) {
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
  console.log(`Calendar edge scope ${mode}: enumerates_artists=${summary.enumerates_artists}, in_sync=${summary.in_sync}${mode === 'sync' ? `, changed=${result.changed}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'calendar_edge_scope_sync_failed');
    process.exitCode = 1;
  });
}
