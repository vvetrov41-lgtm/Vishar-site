import assert from 'node:assert/strict';
import {
  CALLBACK_DOMAIN,
  START_DOMAIN,
  bypassApplicationPayload,
  bypassPolicyPayload,
  isExactBypassEveryone,
} from './calendar-oauth-access-bypass-sync.mjs';

const startApp = bypassApplicationPayload('Start', START_DOMAIN);
assert.deepEqual(startApp, {
  name: 'Start',
  type: 'self_hosted',
  domain: 'calendar.vishartattoo.com/oauth/google/start/*',
  app_launcher_visible: false,
});

const callbackApp = bypassApplicationPayload('Callback', CALLBACK_DOMAIN);
assert.equal(callbackApp.domain, 'calendar.vishartattoo.com/oauth/google/callback');
assert.throws(() => bypassApplicationPayload('Wrong', 'calendar.vishartattoo.com/*'), /bypass_domain_not_allowlisted/);
assert.throws(() => bypassApplicationPayload('Wrong', 'calendar.vishartattoo.com/health'), /bypass_domain_not_allowlisted/);

const policy = bypassPolicyPayload('OAuth bypass');
assert.equal(policy.decision, 'bypass');
assert.equal(policy.precedence, 1);
assert.deepEqual(policy.include, [{ everyone: {} }]);
assert.deepEqual(policy.exclude, []);
assert.deepEqual(policy.require, []);
assert.equal(isExactBypassEveryone(policy), true);

for (const invalid of [
  { ...policy, decision: 'allow' },
  { ...policy, include: [{ email: { email: 'artist@example.com' } }] },
  { ...policy, include: [{ everyone: {} }, { everyone: {} }] },
  { ...policy, exclude: [{ everyone: {} }] },
  { ...policy, require: [{ everyone: {} }] },
  { ...policy, include: [{ everyone: { extra: true } }] },
]) {
  assert.equal(isExactBypassEveryone(invalid), false);
}

console.log('Calendar OAuth Access bypass sync tests passed: two exact public paths only, Everyone bypass shape exact, broader paths refused.');
