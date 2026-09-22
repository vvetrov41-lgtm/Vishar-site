#!/usr/bin/env node
// Audit H-1: a permanent 4xx refusal must not look like a database outage.

import assert from 'node:assert/strict';
import { createSupabaseClient, SupabaseError } from '../workers/lib/supabase.js';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-only',
};

async function codeFor(status) {
  const client = createSupabaseClient(env, async () => Response.json({ message: 'private' }, { status }));
  try {
    await client.rpc('service_run_automation_tick', { p_limit: 1 });
  } catch (error) {
    assert.ok(error instanceof SupabaseError);
    assert.equal(error.status, status);
    return error.code;
  }
  throw new Error(`status ${status} did not reject`);
}

for (const status of [400, 404, 409, 422]) {
  assert.equal(await codeFor(status), 'database_rejected', `HTTP ${status} is a permanent refusal`);
}
for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) {
  assert.equal(await codeFor(status), 'database_unavailable', `HTTP ${status} stays retryable`);
}
console.log('Supabase error classification: 4xx refusals are database_rejected, outages stay database_unavailable.');
