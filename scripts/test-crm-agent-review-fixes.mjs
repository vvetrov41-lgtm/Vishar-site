#!/usr/bin/env node
import assert from 'node:assert/strict';
import { CRM_AGENT_RPCS } from '../workers/lib/supabase.js';
import { projectClientStateInput } from '../workers/lib/crm-agent.js';
import { createGmailSupabase, __testing as gmailTesting } from '../workers/lib/gmail-supabase.js';

const requiredCrmRpcs = [
  'service_claim_crm_agent_jobs',
  'service_complete_client_ai_state_job',
  'service_complete_reference_image_job',
  'service_fail_crm_agent_job',
  'service_telegram_client_ai_digest',
];

for (const rpc of requiredCrmRpcs) {
  assert.equal(CRM_AGENT_RPCS.has(rpc), true, `${rpc} must be accepted by the shared Supabase client`);
}

const hugeInput = {
  client: { full_name: 'Large Client' },
  artist: { display_name: 'Vishar' },
  enquiries: Array.from({ length: 5 }, (_, index) => ({
    reference: `VLA-${index}`,
    status: 'new',
    project_type: 'Tattoo',
    placement: 'Full torso',
    approximate_size: 'Large',
    cover_up: 'Yes',
    preferred_timing: 'November',
    idea: `${index}:`.padEnd(2000, 'x'),
    created_at: '2026-09-10T10:00:00Z',
  })),
  crm_facts: {
    projects: Array.from({ length: 60 }, () => ({
      status: 'active', deposit_status: 'pending', note: 'y'.repeat(500),
    })),
    sessions: Array.from({ length: 60 }, () => ({
      status: 'planned', start_at: '2026-11-10T10:00:00Z', note: 'z'.repeat(500),
    })),
  },
  timeline: [],
  reference_images: Array.from({ length: 6 }, () => ({
    summary: 'reference '.repeat(100),
    analysis: { composition: 'detail '.repeat(300), subjects: Array(20).fill('subject '.repeat(50)) },
  })),
  previous_brief: {
    summary: 'previous '.repeat(300),
    brief: { project_summary: 'history '.repeat(1000), constraints: Array(30).fill('constraint '.repeat(80)) },
  },
};

const projected = projectClientStateInput(hugeInput);
assert.ok(projected, 'oversized non-timeline context must still produce a prompt payload');
assert.ok(projected.length <= 11_000, `prompt payload must stay bounded, got ${projected.length}`);
assert.equal(JSON.parse(projected).untrusted_crm_data.enquiries[0].reference, 'VLA-0');

assert.equal(gmailTesting.BOUNDED_ENRICHMENT_RPCS.has('service_observe_gmail_enquiry_ai'), true);
assert.equal(gmailTesting.BOUNDED_ENRICHMENT_RPCS.has('service_record_gmail_client_message'), true);

let capturedSignal = null;
const gmail = createGmailSupabase({
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/',
  SUPABASE_SECRET_KEY: 'sb_secret_test_only_value',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only_value',
}, async (_url, init) => {
  capturedSignal = init.signal ?? null;
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
});

await gmail.backendRpc('service_record_gmail_client_message', { p_message_id: 'test' });
assert.ok(capturedSignal instanceof AbortSignal, 'Gmail client-message enrichment must carry an abort signal');

console.log('CRM AI review regression tests passed');
