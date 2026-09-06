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

// The live production expression, read from the zone on 2026-09-05.
const ENUMERATING = [
  '(http.host eq "calendar.vishartattoo.com" and not (',
  '  starts_with(http.request.uri.path, "/cdn-cgi/access/") or',
  '  (http.request.method eq "GET" and (',
  '    http.request.uri.path eq "/health" or',
  '    http.request.uri.path eq "/oauth/google/start/vladimir" or',
  '    http.request.uri.path eq "/oauth/google/start/kristina" or',
  '    http.request.uri.path eq "/oauth/google/callback"',
  '  )) or',
  '  ((http.request.method eq "GET" or http.request.method eq "POST") and (',
  '    http.request.uri.path eq "/oauth/google/disconnect/vladimir" or',
  '    http.request.uri.path eq "/oauth/google/disconnect/kristina"',
  '  ))',
  '))',
].join('\n');

function rule(overrides = {}, filterOverrides = {}) {
  return {
    id: 'c'.repeat(32),
    action: 'block',
    paused: false,
    description: 'Vishar Calendar production path boundary',
    filter: {
      id: 'f'.repeat(32),
      paused: false,
      expression: ENUMERATING,
      ...filterOverrides,
    },
    ...overrides,
  };
}

function unrelatedRule() {
  return {
    id: 'u'.repeat(32),
    action: 'block',
    paused: false,
    description: 'Vishar Team admin production path boundary',
    filter: { id: 'g'.repeat(32), paused: false, expression: '(http.host eq "team.vishartattoo.com")' },
  };
}

function fake({ rules, failReadback = false, mutateNeighbour = false } = {}) {
  let current = rules ?? [unrelatedRule(), rule()];
  let putCount = 0;
  let touchedOtherZone = false;
  const written = [];

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
    if (method === 'GET' && path === `/client/v4/zones/${zoneId}/firewall/rules?per_page=100`) {
      if (failReadback && putCount === 1) {
        return ok(current.map((row) => (row.filter.expression.includes('calendar.vishartattoo.com')
          ? { ...row, filter: { ...row.filter, expression: '(http.host eq "calendar.vishartattoo.com")' } }
          : row)));
      }
      return ok(current);
    }
    if (method === 'PUT' && path.startsWith(`/client/v4/zones/${zoneId}/filters/`)) {
      putCount += 1;
      const filterId = path.split('/').pop();
      const body = JSON.parse(init.body || '{}');
      written.push(body.expression);
      current = current.map((row) => (row.filter.id === filterId
        ? { ...row, filter: { ...row.filter, ...body } }
        : row));
      if (mutateNeighbour) {
        current = current.map((row) => (row.filter.id === filterId ? row : { ...row, paused: true }));
      }
      return ok(body);
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), { status: 404 });
  }

  return {
    options: { token, fetchImpl },
    getPutCount: () => putCount,
    getRules: () => current,
    getWritten: () => written,
    touchedOtherZone: () => touchedOtherZone,
  };
}

// --- the replacement expression itself ---------------------------------------

{
  const expression = expectedExpression();
  assert.equal(enumeratesArtists(expression), false, 'the replacement must not name any artist');
  assert.equal(enumeratesArtists(ENUMERATING), true, 'the live production shape is per-artist enumeration');
  assert.doesNotMatch(expression, /vladimir|kristina/i);

  // Everything except the artist dimension and the narrowly required start
  // methods is carried over. Losing the Access exemption in particular would
  // break the connector for every artist, including the two that work today.
  assert.match(expression, /starts_with\(http\.request\.uri\.path, "\/cdn-cgi\/access\/"\)/);
  assert.match(expression, /http\.host eq "calendar\.vishartattoo\.com"/);
  assert.match(expression, /http\.request\.uri\.path eq "\/health"/);
  assert.match(expression, /http\.request\.uri\.path eq "\/oauth\/google\/callback"/);
  assert.match(expression, /starts_with\(http\.request\.uri\.path, "\/oauth\/google\/start\/"\)/);
  assert.match(expression, /starts_with\(http\.request\.uri\.path, "\/oauth\/google\/disconnect\/"\)/);

  // GET remains for the existing health/callback/start boundary and rollout
  // probes. The only widening is POST + OPTIONS for the start prefix, matching
  // the authenticated CRM request and browser CORS preflight. Disconnect stays
  // GET + POST exactly as before.
  assert.match(expression, /\(http\.request\.method eq "GET" and \(/);
  assert.match(
    expression,
    /\(\(http\.request\.method eq "POST" or http\.request\.method eq "OPTIONS"\) and\n\s+starts_with\(http\.request\.uri\.path, "\/oauth\/google\/start\/"\)\)/,
  );
  assert.match(
    expression,
    /\(\(http\.request\.method eq "GET" or http\.request\.method eq "POST"\) and\n\s+starts_with\(http\.request\.uri\.path, "\/oauth\/google\/disconnect\/"\)\)/,
  );
  assert.doesNotMatch(
    expression,
    /http\.request\.method eq "OPTIONS"[^\n]*disconnect/,
    'OPTIONS must not be widened to disconnect',
  );
  assert.equal(expression, expectedExpression(), 'the expression must be deterministic');
}

// --- rule selection guards ---------------------------------------------------

{
  assert.equal(selectCalendarRule([unrelatedRule(), rule()]).id, 'c'.repeat(32));
  assert.throws(() => selectCalendarRule([]), /calendar_edge_ruleset_is_empty/);
  assert.throws(() => selectCalendarRule([unrelatedRule()]), /calendar_edge_rule_not_unique:0/);
  assert.throws(() => selectCalendarRule([rule(), rule({ id: 'd'.repeat(32) })]), /calendar_edge_rule_not_unique:2/);
  assert.throws(() => selectCalendarRule([rule({ action: 'skip' })]), /calendar_edge_rule_action_unsupported:skip/);
  assert.throws(() => selectCalendarRule([rule({ paused: true })]), /calendar_edge_rule_is_disabled/);
  assert.throws(() => selectCalendarRule([rule({}, { id: '' })]), /calendar_edge_filter_id_invalid/);
  assert.notEqual(
    otherRulesDigest([unrelatedRule(), rule()], 'c'.repeat(32)),
    otherRulesDigest([{ ...unrelatedRule(), paused: true }, rule()], 'c'.repeat(32)),
    'a neighbouring rule change must change the digest',
  );
}

// --- replacing the enumeration ----------------------------------------------

{
  const fake0 = fake();
  const inspected = await inspectCalendarEdgeScope(fake0.options);
  assert.equal(inspected.host, 'calendar.vishartattoo.com');
  assert.equal(inspected.source, 'zone_legacy_firewall_rule');
  assert.equal(inspected.enumerates_artists, true);
  assert.equal(inspected.allows_access_endpoints, true);
  assert.equal(inspected.in_sync, false);
  assert.equal(fake0.getPutCount(), 0, 'inspect must never mutate');

  const synced = await syncCalendarEdgeScope(fake0.options);
  assert.equal(synced.changed, true);
  assert.equal(synced.after.in_sync, true);
  assert.equal(synced.after.enumerates_artists, false);
  assert.equal(synced.after.allows_access_endpoints, true);
  assert.equal(fake0.getPutCount(), 1);
  assert.deepEqual(fake0.getWritten(), [expectedExpression()]);
  assert.equal(fake0.getRules().find((row) => row.id === 'u'.repeat(32)).paused, false, 'neighbouring rules stay untouched');
  assert.equal(fake0.getRules().find((row) => row.id === 'c'.repeat(32)).action, 'block', 'the action is never rewritten');
  assert.equal(fake0.touchedOtherZone(), false, 'only the production zone may be read or written');
}

// --- idempotence -------------------------------------------------------------

{
  const fake1 = fake({ rules: [unrelatedRule(), rule({}, { expression: expectedExpression() })] });
  const synced = await syncCalendarEdgeScope(fake1.options);
  assert.equal(synced.changed, false);
  assert.equal(fake1.getPutCount(), 0);
}

// --- fail closed -------------------------------------------------------------

{
  // A rule that does not already exempt Access is not the rule this script was
  // written against, so it is left alone rather than rewritten.
  const withoutAccess = ENUMERATING.replace('  starts_with(http.request.uri.path, "/cdn-cgi/access/") or\n', '');
  const fake2 = fake({ rules: [unrelatedRule(), rule({}, { expression: withoutAccess })] });
  await assert.rejects(() => syncCalendarEdgeScope(fake2.options), /calendar_edge_rule_does_not_exempt_access/);
  assert.equal(fake2.getPutCount(), 0);
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
  assert.equal(fake3.getPutCount(), 2, 'a failed readback must restore the original expression');
  assert.equal(fake3.getWritten()[1], ENUMERATING);
}

{
  // A write that moves a neighbouring rule is rolled back even though the
  // Calendar rule itself came back exactly as intended.
  const fake4 = fake({ mutateNeighbour: true });
  await assert.rejects(() => syncCalendarEdgeScope(fake4.options), /calendar_edge_collateral_rule_change/);
  assert.equal(fake4.getWritten()[1], ENUMERATING);
}

console.log('calendar edge scope sync tests passed');
