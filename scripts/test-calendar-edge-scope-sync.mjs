#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  expectedExpression,
  enumeratesArtists,
  selectCalendarRule,
  otherRulesDigest,
  inspectCalendarEdgeScope,
  syncCalendarEdgeScope,
} from './calendar-edge-scope-sync.mjs';

const token = 't'.repeat(40);
const zoneId = 'z'.repeat(32);
const rulesetId = 'r'.repeat(32);

const ENUMERATING = '(http.host eq "calendar.vishartattoo.com" and not ('
  + 'http.request.uri.path eq "/health" or http.request.uri.path eq "/oauth/google/callback" or '
  + 'http.request.uri.path eq "/oauth/google/start/vladimir" or http.request.uri.path eq "/oauth/google/start/kristina" or '
  + 'http.request.uri.path eq "/oauth/google/disconnect/vladimir" or http.request.uri.path eq "/oauth/google/disconnect/kristina"))';

function rule(overrides = {}) {
  return {
    id: 'c'.repeat(32),
    action: 'block',
    enabled: true,
    description: 'Calendar connector path scope',
    expression: ENUMERATING,
    ...overrides,
  };
}

function unrelatedRule() {
  return {
    id: 'u'.repeat(32),
    action: 'block',
    enabled: true,
    description: 'block a bad country',
    expression: '(ip.geoip.country eq "XX")',
  };
}

function fake({ rules, failReadback = false, mutateNeighbour = false, rulesetKind = 'zone' } = {}) {
  let current = rules ?? [unrelatedRule(), rule()];
  let patchCount = 0;
  let touchedOtherZone = false;
  const patched = [];

  const ok = (result) => new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const method = (init.method || 'GET').toUpperCase();

    if (path.startsWith('/client/v4/zones?name=')) {
      return ok([{ id: zoneId, name: 'vishartattoo.com' }, { id: 'other', name: 'example.com' }]);
    }
    if (!path.startsWith(`/client/v4/zones/${zoneId}`)) {
      touchedOtherZone = true;
      return ok(null);
    }
    if (method === 'GET' && path === `/client/v4/zones/${zoneId}/rulesets`) {
      return ok([
        { id: 'managed', phase: 'http_request_firewall_managed', kind: 'zone' },
        { id: rulesetId, phase: 'http_request_firewall_custom', kind: rulesetKind },
      ]);
    }
    if (method === 'GET' && path === `/client/v4/zones/${zoneId}/rulesets/${rulesetId}`) {
      if (failReadback && patchCount === 1) {
        return ok({ id: rulesetId, rules: current.map((row) => (row.expression.includes('calendar.vishartattoo.com')
          ? { ...row, expression: '(http.host eq "calendar.vishartattoo.com")' }
          : row)) });
      }
      return ok({ id: rulesetId, rules: current });
    }
    if (method === 'PATCH' && path.startsWith(`/client/v4/zones/${zoneId}/rulesets/${rulesetId}/rules/`)) {
      patchCount += 1;
      const ruleId = path.split('/').pop();
      const body = JSON.parse(init.body || '{}');
      patched.push(body.expression);
      current = current.map((row) => (row.id === ruleId ? { ...row, ...body } : row));
      if (mutateNeighbour) {
        current = current.map((row) => (row.id === ruleId ? row : { ...row, enabled: false }));
      }
      return ok({ id: rulesetId, rules: current });
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), { status: 404 });
  }

  return {
    options: { token, fetchImpl },
    getPatchCount: () => patchCount,
    getRules: () => current,
    getPatched: () => patched,
    touchedOtherZone: () => touchedOtherZone,
  };
}

// --- the replacement expression itself ---------------------------------------

{
  const expression = expectedExpression();
  assert.equal(enumeratesArtists(expression), false, 'the replacement must not name any artist');
  assert.equal(enumeratesArtists(ENUMERATING), true, 'the current production shape is per-artist enumeration');
  assert.match(expression, /http\.host eq "calendar\.vishartattoo\.com"/);
  // Deny-by-default survives: only the Worker's four route shapes are exempt.
  assert.match(expression, /http\.request\.uri\.path eq "\/health"/);
  assert.match(expression, /http\.request\.uri\.path eq "\/oauth\/google\/callback"/);
  assert.match(expression, /starts_with\(http\.request\.uri\.path, "\/oauth\/google\/start\/"\)/);
  assert.match(expression, /starts_with\(http\.request\.uri\.path, "\/oauth\/google\/disconnect\/"\)/);
  assert.doesNotMatch(expression, /vladimir|kristina/i);
  assert.equal(expression, expectedExpression(), 'the expression must be deterministic');
}

// --- rule selection guards ---------------------------------------------------

{
  assert.equal(selectCalendarRule([unrelatedRule(), rule()]).id, 'c'.repeat(32));
  assert.throws(() => selectCalendarRule([]), /calendar_edge_ruleset_is_empty/);
  assert.throws(() => selectCalendarRule([unrelatedRule()]), /calendar_edge_rule_not_unique:0/);
  assert.throws(() => selectCalendarRule([rule(), rule({ id: 'd'.repeat(32) })]), /calendar_edge_rule_not_unique:2/);
  assert.throws(() => selectCalendarRule([rule({ action: 'skip' })]), /calendar_edge_rule_action_unsupported:skip/);
  assert.throws(() => selectCalendarRule([rule({ enabled: false })]), /calendar_edge_rule_is_disabled/);
  assert.notEqual(
    otherRulesDigest([unrelatedRule(), rule()], 'c'.repeat(32)),
    otherRulesDigest([{ ...unrelatedRule(), enabled: false }, rule()], 'c'.repeat(32)),
    'a neighbouring rule change must change the digest',
  );
}

// --- replacing the enumeration ----------------------------------------------

{
  const fake0 = fake();
  const inspected = await inspectCalendarEdgeScope(fake0.options);
  assert.equal(inspected.host, 'calendar.vishartattoo.com');
  assert.equal(inspected.enumerates_artists, true);
  assert.equal(inspected.in_sync, false);
  assert.equal(fake0.getPatchCount(), 0, 'inspect must never mutate');

  const synced = await syncCalendarEdgeScope(fake0.options);
  assert.equal(synced.changed, true);
  assert.equal(synced.after.in_sync, true);
  assert.equal(synced.after.enumerates_artists, false);
  assert.equal(fake0.getPatchCount(), 1);
  assert.deepEqual(fake0.getPatched(), [expectedExpression()]);
  assert.equal(fake0.getRules().find((row) => row.id === 'u'.repeat(32)).enabled, true, 'neighbouring rules stay untouched');
  assert.equal(fake0.touchedOtherZone(), false, 'only the production zone may be read or written');
}

// --- idempotence -------------------------------------------------------------

{
  const fake1 = fake({ rules: [unrelatedRule(), rule({ expression: expectedExpression() })] });
  const synced = await syncCalendarEdgeScope(fake1.options);
  assert.equal(synced.changed, false);
  assert.equal(fake1.getPatchCount(), 0);
}

// --- fail closed -------------------------------------------------------------

{
  const fake2 = fake({ rulesetKind: 'custom' });
  await assert.rejects(() => syncCalendarEdgeScope(fake2.options), /custom_firewall_entrypoint_not_unique/);
  assert.equal(fake2.getPatchCount(), 0);
}

{
  await assert.rejects(
    () => inspectCalendarEdgeScope({ token: '', fetchImpl: fetch }),
    /cloudflare_api_token_missing/,
  );
}

// --- rollback ----------------------------------------------------------------

{
  const fake3 = fake({ failReadback: true });
  await assert.rejects(() => syncCalendarEdgeScope(fake3.options), /calendar_edge_readback_mismatch/);
  assert.equal(fake3.getPatchCount(), 2, 'a failed readback must restore the original expression');
  assert.equal(fake3.getPatched()[1], ENUMERATING);
}

{
  // A patch that moves a neighbouring rule is rolled back even though the
  // Calendar rule itself came back exactly as intended.
  const fake4 = fake({ mutateNeighbour: true });
  await assert.rejects(() => syncCalendarEdgeScope(fake4.options), /calendar_edge_collateral_rule_change/);
  assert.equal(fake4.getPatched()[1], ENUMERATING);
}

console.log('calendar edge scope sync tests passed');
