import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionMetaToken, TARGET } from './provision-meta-capi-production-token.mjs';

const env = { CLOUDFLARE_ACCOUNT_ID: TARGET.account, CLOUDFLARE_API_TOKEN: 'mock-cf', META_ADS_VLADIMIR_ACCESS_TOKEN: 'mock-meta' };
const existing = ['ARTIST_TELEGRAM_KRISTINA_HPRODUCTION', 'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION', 'SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];
const settings = { bindings: [
  { name: 'VISHAR_ENVIRONMENT', type: 'plain_text', text: 'production' },
  { name: 'SUPABASE_URL', type: 'plain_text', text: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co' },
  { name: 'GMAIL_SERVICE', type: 'service', service: 'vishar-gmail-production' },
], compatibility_date: '2026-08-22' };
function harness({ identity = TARGET.systemUser, permission = true, pixel = TARGET.pixel, initial = settings, secretNames = existing, postNames, postSettings = settings, reject = false } = {}) {
  const requests = [];
  let patched = false;
  const fetchImpl = async (url, init) => {
    requests.push({ url, ...init });
    assert.equal(url.includes('mock-'), false, 'credentials cannot enter URLs');
    assert.equal(init.redirect, 'error');
    let payload;
    if (reject) payload = { success: false, errors: [{ message: 'mock-meta' }] };
    else if (url.endsWith('/me?fields=id,name')) payload = { id: identity, name: identity === 'other-user' ? 'Other User' : 'Vishar CRM Integration' };
    else if (url.endsWith('/692776505711216/system_users?fields=id,name&limit=100')) payload = { data: [{ id: identity === 'foreign-user' ? 'not-matching' : identity, name: 'Vishar CRM Integration' }] };
    else if (url.endsWith('/me/permissions')) payload = { data: [{ permission: 'ads_read', status: permission ? 'granted' : 'declined' }] };
    else if (url.includes(`/${TARGET.pixel}?fields=id`)) payload = { id: pixel };
    else if (url.endsWith('/settings')) payload = { success: true, result: patched ? postSettings : initial };
    else if (url.endsWith('/secrets')) payload = { success: true, result: (patched ? (postNames || [...secretNames, TARGET.secret]) : secretNames).map(name => ({ name, type: 'secret_text' })) };
    else if (url.endsWith('/secrets-bulk') && init.method === 'PATCH') { patched = true; payload = { success: true, result: {} }; }
    else throw new Error('Unexpected mock provider operation');
    return { ok: !reject, status: reject ? 403 : 200, json: async () => payload };
  };
  return { fetchImpl, requests };
}
test('default validation never mutates a provider or returns a credential', async () => {
  const h = harness();
  const result = await provisionMetaToken({ env, fetchImpl: h.fetchImpl });
  assert.ok(h.requests.every(r => r.method === 'GET'));
  assert.equal(result.capi_delivery_verified, false);
  assert.equal(JSON.stringify(result).includes('mock-meta'), false);
});
test('provisioning sends exactly one fixed secret in a merge patch and preserves metadata', async () => {
  const h = harness();
  const result = await provisionMetaToken({ env, provision: true, fetchImpl: h.fetchImpl });
  const writes = h.requests.filter(r => r.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.ok(writes[0].url.includes(`/workers/scripts/${TARGET.worker}/secrets-bulk`));
  assert.deepEqual(JSON.parse(writes[0].body), { secrets: { [TARGET.secret]: { name: TARGET.secret, type: 'secret_text', text: 'mock-meta' } } });
  assert.equal(result.existing_secret_names_preserved, true);
});
test('wrong identity, permission, Pixel, backend or enabled drain fails before a write', async () => {
  for (const options of [
    { identity: 'other-user' }, { identity: 'foreign-user' }, { permission: false }, { pixel: 'old-pixel' },
    { initial: { bindings: [] } },
    { initial: { ...settings, bindings: [...settings.bindings, { name: 'META_ADS_DRAIN_ENABLED', type: 'plain_text', text: 'true' }] } },
    { secretNames: [...existing, TARGET.secret] }, { secretNames: existing.slice(1) },
  ]) {
    const h = harness(options);
    await assert.rejects(provisionMetaToken({ env, provision: true, fetchImpl: h.fetchImpl }));
    assert.ok(h.requests.every(r => r.method === 'GET'));
  }
});
test('wrong account is rejected before credential transmission', async () => {
  const h = harness();
  await assert.rejects(provisionMetaToken({ env: { ...env, CLOUDFLARE_ACCOUNT_ID: 'other-account' }, provision: true, fetchImpl: h.fetchImpl }));
  assert.equal(h.requests.length, 0);
});
test('post-provision loss of old secrets or change of service bindings is rejected', async () => {
  for (const options of [{ postNames: [TARGET.secret] }, { postSettings: { bindings: settings.bindings.slice(0, 2) } }]) {
    const h = harness(options);
    await assert.rejects(provisionMetaToken({ env, provision: true, fetchImpl: h.fetchImpl }), /Post-provision/);
  }
});
test('provider error contents and credentials are suppressed', async () => {
  const h = harness({ reject: true });
  await assert.rejects(provisionMetaToken({ env, provision: true, fetchImpl: h.fetchImpl }), e => !e.message.includes('mock-meta') && e.message.includes('HTTP 403'));
});

test('app-scoped system-user ID is accepted only with business directory identity proof', async () => {
  const h = harness({ identity: 'app-scoped-vishar-user' });
  const result = await provisionMetaToken({ env, fetchImpl: h.fetchImpl });
  assert.equal(result.token_read_access_verified, true);
  assert.ok(h.requests.every(r => r.method === 'GET'));
});
