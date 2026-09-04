#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  policyFingerprint,
  operatorEmailsFrom,
  inspectCalendarAccess,
  syncCalendarAccess,
} from './calendar-access-sync.mjs';

function emailRule(email) {
  return { email: { email } };
}

function policy(id, emails, extras = {}) {
  return {
    id,
    name: extras.name || 'policy',
    decision: extras.decision || 'allow',
    precedence: 1,
    include: emails.map(emailRule),
    exclude: extras.exclude || [],
    require: extras.require || [],
  };
}

function directory(emails, ownerEmail = emails[0]) {
  return emails.map((email) => ({ operator_email: email, is_owner: email === ownerEmail }));
}

const supabaseUrl = `https://${'a'.repeat(20)}.supabase.co`;
const supabaseKey = 's'.repeat(40);
const accountId = 'a'.repeat(32);
const token = 't'.repeat(40);

function fake({ operators, targetEmails, failReadback = false, directoryStatus = 200, directoryBody = null }) {
  const targetApp = { id: 'target-app', domain: 'calendar.vishartattoo.com' };
  const otherApp = { id: 'source-app', domain: 'app.vishartattoo.com' };
  let targetPolicy = policy('target-policy', targetEmails, { name: 'Vishar Calendar production owner only' });
  let putCount = 0;
  let directoryCalls = 0;
  let touchedOtherApp = false;

  const response = (status, result, success = true) => new Response(JSON.stringify({ success, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = (init.method || 'GET').toUpperCase();

    if (parsed.host.endsWith('.supabase.co')) {
      directoryCalls += 1;
      assert.equal(method, 'POST');
      assert.equal(path, '/rest/v1/rpc/list_calendar_access_operators');
      assert.equal(init.headers.apikey, supabaseKey);
      if (directoryStatus !== 200) return new Response('{}', { status: directoryStatus });
      return new Response(JSON.stringify(directoryBody ?? directory(operators)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (path.includes('/source-app')) touchedOtherApp = true;
    if (method === 'GET' && path.endsWith('/access/apps')) return response(200, [otherApp, targetApp]);
    if (method === 'GET' && path.endsWith('/target-app/policies')) {
      if (failReadback && putCount === 1) {
        return response(200, [policy('target-policy', ['unexpected@example.com'])]);
      }
      return response(200, [targetPolicy]);
    }
    if (method === 'PUT' && path.endsWith('/target-app/policies/target-policy')) {
      putCount += 1;
      const body = JSON.parse(init.body || '{}');
      targetPolicy = { ...targetPolicy, ...body, id: 'target-policy' };
      return response(200, targetPolicy);
    }
    return response(404, null, false);
  }

  return {
    options: { accountId, token, supabaseUrl, supabaseKey, fetchImpl },
    getPutCount: () => putCount,
    getDirectoryCalls: () => directoryCalls,
    getTarget: () => targetPolicy,
    touchedOtherApp: () => touchedOtherApp,
  };
}

// --- directory validation ---------------------------------------------------

{
  assert.deepEqual(
    operatorEmailsFrom(directory(['Staff@Example.com'.toLowerCase(), 'owner@example.com'], 'owner@example.com')),
    ['owner@example.com', 'staff@example.com'],
    'the directory is normalised and ordered so the digest is stable',
  );
}

{
  // Fail closed: an empty or owner-less directory must never become a policy.
  assert.throws(() => operatorEmailsFrom([]), /operator_directory_is_empty/);
  assert.throws(
    () => operatorEmailsFrom([{ operator_email: 'staff@example.com', is_owner: false }]),
    /operator_directory_has_no_owner/,
  );
  assert.throws(() => operatorEmailsFrom(null), /operator_directory_shape_invalid/);
  assert.throws(
    () => operatorEmailsFrom([{ operator_email: 'not-an-email', is_owner: true }]),
    /operator_directory_email_invalid/,
  );
  assert.throws(
    () => operatorEmailsFrom([{ operator_email: 'owner@example.com', is_owner: 'yes' }]),
    /operator_directory_owner_flag_invalid/,
  );
  assert.throws(
    () => operatorEmailsFrom(directory(['owner@example.com', 'owner@example.com'], 'owner@example.com')),
    /operator_directory_has_duplicates/,
  );
}

// --- policy shape guards ----------------------------------------------------

{
  const fp1 = policyFingerprint(policy('x', ['staff@example.com', 'owner@example.com']), 'test');
  const fp2 = policyFingerprint(policy('y', ['owner@example.com', 'staff@example.com']), 'test');
  assert.equal(fp1.digest, fp2.digest);
  assert.equal(fp1.count, 2);
  assert.throws(() => policyFingerprint({ ...policy('x', ['a@example.com']), include: [{ everyone: {} }] }, 'test'), /email_only/);
  assert.throws(() => policyFingerprint({ ...policy('x', ['a@example.com']), include: [{ email_domain: { domain: 'example.com' } }] }, 'test'), /email_only/);
}

// --- onboarding a new artist's operator needs no Cloudflare edit -------------

{
  const fake0 = fake({
    operators: ['owner@example.com', 'kristina@example.com', 'sam@example.test'],
    targetEmails: ['owner@example.com', 'kristina@example.com'],
  });
  const inspected = await inspectCalendarAccess(fake0.options);
  assert.equal(inspected.source_kind, 'supabase_operator_directory');
  assert.equal(inspected.source_email_rule_count, 3);
  assert.equal(inspected.target_email_rule_count, 2);
  assert.equal(inspected.in_sync, false);
  assert.equal(fake0.getPutCount(), 0, 'inspect must never mutate');

  const synced = await syncCalendarAccess(fake0.options);
  assert.equal(synced.changed, true);
  assert.equal(synced.after.in_sync, true);
  assert.equal(fake0.getPutCount(), 1);
  assert.deepEqual(
    policyFingerprint(fake0.getTarget(), 'target'),
    policyFingerprint(policy('expected', ['kristina@example.com', 'owner@example.com', 'sam@example.test']), 'expected'),
  );
  assert.equal(fake0.getTarget().exclude.length, 0);
  assert.equal(fake0.getTarget().require.length, 0);
  assert.equal(fake0.touchedOtherApp(), false, 'only the Calendar Access app may be read or written');
}

// --- removing a membership narrows the boundary -----------------------------

{
  const fake1 = fake({
    operators: ['owner@example.com'],
    targetEmails: ['owner@example.com', 'departed@example.com'],
  });
  const synced = await syncCalendarAccess(fake1.options);
  assert.equal(synced.changed, true);
  assert.equal(policyFingerprint(fake1.getTarget(), 'target').count, 1);
}

// --- idempotence ------------------------------------------------------------

{
  const fake2 = fake({ operators: ['owner@example.com'], targetEmails: ['owner@example.com'] });
  const synced = await syncCalendarAccess(fake2.options);
  assert.equal(synced.changed, false);
  assert.equal(fake2.getPutCount(), 0);
}

// --- fail closed ------------------------------------------------------------

{
  const fake3 = fake({ operators: ['owner@example.com'], targetEmails: ['owner@example.com'], directoryStatus: 503 });
  await assert.rejects(
    () => syncCalendarAccess(fake3.options),
    /supabase_operator_directory_failed:503/,
  );
  assert.equal(fake3.getPutCount(), 0, 'an unreachable directory must leave the boundary untouched');
}

{
  const fake4 = fake({
    operators: ['owner@example.com'],
    targetEmails: ['owner@example.com', 'staff@example.com'],
    directoryBody: [],
  });
  await assert.rejects(() => syncCalendarAccess(fake4.options), /operator_directory_is_empty/);
  assert.equal(fake4.getPutCount(), 0, 'an empty directory must never empty the policy');
}

{
  const fake5 = fake({
    operators: ['owner@example.com'],
    targetEmails: ['owner@example.com', 'staff@example.com'],
    directoryBody: [{ operator_email: 'staff@example.com', is_owner: false }],
  });
  await assert.rejects(() => syncCalendarAccess(fake5.options), /operator_directory_has_no_owner/);
  assert.equal(fake5.getPutCount(), 0, 'losing every owner must not lock the account out');
}

{
  await assert.rejects(
    () => inspectCalendarAccess({ accountId, token, supabaseUrl: 'https://evil.example.com', supabaseKey, fetchImpl: fetch }),
    /supabase_url_invalid/,
  );
  await assert.rejects(
    () => inspectCalendarAccess({ accountId, token, supabaseUrl, supabaseKey: '', fetchImpl: fetch }),
    /supabase_secret_key_missing/,
  );
}

// --- rollback ---------------------------------------------------------------

{
  const fake6 = fake({
    operators: ['owner@example.com', 'staff@example.com'],
    targetEmails: ['owner@example.com'],
    failReadback: true,
  });
  await assert.rejects(() => syncCalendarAccess(fake6.options), /calendar_access_readback_mismatch/);
  assert.equal(fake6.getPutCount(), 2, 'failed readback must roll the target policy back');
  assert.equal(policyFingerprint(fake6.getTarget(), 'target').count, 1);
}

console.log('calendar access sync tests passed');
