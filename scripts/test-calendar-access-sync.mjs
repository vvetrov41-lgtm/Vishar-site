#!/usr/bin/env node

import assert from 'node:assert/strict';
import { policyFingerprint, inspectCalendarAccess, syncCalendarAccess } from './calendar-access-sync.mjs';

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

function fakeCloudflare({ sourceEmails, targetEmails, failReadback = false }) {
  const sourceApp = { id: 'source-app', domain: 'app.vishartattoo.com' };
  const targetApp = { id: 'target-app', domain: 'calendar.vishartattoo.com' };
  const sourcePolicy = policy('source-policy', sourceEmails, { name: 'Owner and named staff only' });
  let targetPolicy = policy('target-policy', targetEmails, { name: 'Vishar Calendar production owner only' });
  let putCount = 0;

  const response = (status, result, success = true) => new Response(JSON.stringify({ success, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  async function fetchImpl(url, init = {}) {
    const path = new URL(url).pathname;
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET' && path.endsWith('/access/apps')) return response(200, [sourceApp, targetApp]);
    if (method === 'GET' && path.endsWith('/source-app/policies')) return response(200, [sourcePolicy]);
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
  return { fetchImpl, getPutCount: () => putCount, getTarget: () => targetPolicy };
}

const accountId = 'a'.repeat(32);
const token = 't'.repeat(40);

{
  const fp1 = policyFingerprint(policy('x', ['Staff@Example.com', 'owner@example.com']), 'test');
  const fp2 = policyFingerprint(policy('y', ['owner@example.com', 'staff@example.com']), 'test');
  assert.equal(fp1.digest, fp2.digest);
  assert.equal(fp1.count, 2);
}

{
  assert.throws(() => policyFingerprint({ ...policy('x', ['a@example.com']), include: [{ everyone: {} }] }, 'test'), /email_only/);
  assert.throws(() => policyFingerprint({ ...policy('x', ['a@example.com']), include: [{ email_domain: { domain: 'example.com' } }] }, 'test'), /email_only/);
}

{
  const fake = fakeCloudflare({ sourceEmails: ['owner@example.com', 'staff@example.com'], targetEmails: ['owner@example.com'] });
  const inspected = await inspectCalendarAccess({ accountId, token, fetchImpl: fake.fetchImpl });
  assert.equal(inspected.source_email_rule_count, 2);
  assert.equal(inspected.target_email_rule_count, 1);
  assert.equal(inspected.in_sync, false);

  const synced = await syncCalendarAccess({ accountId, token, fetchImpl: fake.fetchImpl });
  assert.equal(synced.changed, true);
  assert.equal(synced.after.in_sync, true);
  assert.equal(fake.getPutCount(), 1);
  assert.deepEqual(policyFingerprint(fake.getTarget(), 'target'), policyFingerprint(policy('expected', ['owner@example.com', 'staff@example.com']), 'expected'));
}

{
  const fake = fakeCloudflare({ sourceEmails: ['owner@example.com'], targetEmails: ['owner@example.com'] });
  const synced = await syncCalendarAccess({ accountId, token, fetchImpl: fake.fetchImpl });
  assert.equal(synced.changed, false);
  assert.equal(fake.getPutCount(), 0);
}

{
  const fake = fakeCloudflare({ sourceEmails: ['owner@example.com', 'staff@example.com'], targetEmails: ['owner@example.com'], failReadback: true });
  await assert.rejects(() => syncCalendarAccess({ accountId, token, fetchImpl: fake.fetchImpl }), /calendar_access_readback_mismatch/);
  assert.equal(fake.getPutCount(), 2, 'failed readback must roll the target policy back');
  assert.equal(policyFingerprint(fake.getTarget(), 'target').count, 1);
}

console.log('calendar access sync tests passed');
