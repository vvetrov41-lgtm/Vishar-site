import test from 'node:test';import assert from 'node:assert/strict';import {isGuidePilotRecipient} from './pilot.mjs';
const digest=async email=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email))),b=>b.toString(16).padStart(2,'0')).join('');
test('normalized two-recipient allowlist is exact and fails closed',async()=>{
 const digests=await Promise.all(['test@example.invalid','second@example.invalid'].map(digest));
 assert.equal(await isGuidePilotRecipient(' TEST@example.invalid ',digests),true);
 assert.equal(await isGuidePilotRecipient('SECOND@example.invalid',digests),true);
 assert.equal(await isGuidePilotRecipient('other@example.invalid',digests),false);
 for(const bad of [[],['bad'],null,'bad'])assert.equal(await isGuidePilotRecipient('test@example.invalid',bad),false);
 assert.equal(await isGuidePilotRecipient('test@example.invalid'),false);
});
