#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'booking/index.html'), 'utf8');
const section = source.match(/    function trackGa4Lead\(\) \{[\s\S]*?\n    \}\n/);
assert.ok(section, 'GA4 success tracker must exist');
assert.equal((source.match(/        trackGa4Lead\(\);/g) || []).length, 2,
  'Both legacy and v2 successful submissions must track GA4');
assert.match(source, /For cover-ups, please attach at least one clear photo/);

function simulate(consent, tagPresent, version) {
  const calls = [];
  const context = {
    GENERIC_CONSENT_KEY: 'vishar-cookie-consent',
    storedConsent: () => consent,
    window: { gtag: (...args) => calls.push(args) },
    document: {
      documentElement: { getAttribute: () => version },
      getElementById: () => tagPresent ? {} : null,
    },
    console: { warn: () => assert.fail('Unexpected GA4 error') },
  };
  vm.runInNewContext(section[0] + '\ntrackGa4Lead();', context);
  return calls;
}
assert.equal(simulate('denied', true, 'v2').length, 0);
assert.equal(simulate(null, true, 'v2').length, 0);
assert.equal(simulate('granted', false, 'v2').length, 0);
for (const version of ['v2', 'legacy']) {
  const calls = simulate('granted', true, version);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'event');
  assert.equal(calls[0][1], 'generate_lead');
  assert.equal(calls[0][2].method, 'booking_form');
  assert.equal(calls[0][2].form_version, version);
  assert.equal(Object.keys(calls[0][2]).length, 2, 'No client PII in GA4 event');
}
console.log('GA4 lead tracking tests passed (consent + both form versions).');
