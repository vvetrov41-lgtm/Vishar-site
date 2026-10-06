#!/usr/bin/env node
// Regression: reviewing an enquiry through the Vishar CRM Plugin brings the
// stored vision analyses of its photos without a separate request.
//
// The path is exercised end to end with the real code: MCP tool registry ->
// callPluginMcpTool -> GPT actions handler -> gpt_get_enquiry_full RPC (the
// database row is faked). The tool description and the server instructions
// must tell the model to use reference_analyses with the client's text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPluginTools } from './build-mcp-plugin-tools.mjs';
import { callPluginMcpTool } from '../workers/lib/mcp-plugin-actions.js';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions-combined.js';

const ENQUIRY = '33333333-3333-4333-8333-333333333333';
const ANALYSES = Object.freeze({
  note: 'Stored vision-model analysis of the client\'s attached photos, not re-summarised. Photos are numbered as in the CRM.',
  images: [{
    image: '1 of 2',
    summary: 'Faded blue-grey old tattoo on the upper forearm next to a red marker sketch of two flowers.',
    image_kind: 'existing_tattoo',
    existing_tattoo_visible: true,
    body_area: 'forearm',
    subjects: ['faded old tattoo', 'red marker flower sketch'],
    model: '@cf/qwen/qwen3.8-27b',
    analysed_at: '2026-10-02T17:00:56Z',
  }],
  not_analysed: ['2 of 2'],
});
const ROW = { enquiry_id: ENQUIRY, idea: 'Cover up half arms just front', cover_up: 'Yes', placement: 'Forearm', reference_analyses: ANALYSES };

let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; } catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}

const tools = buildPluginTools();
const enquiryFull = tools.find((tool) => tool.operationId === 'getEnquiryFull');

await test('reviewing an enquiry returns its image analyses in the same tool result, unchanged', async () => {
  const rpcCalls = [];
  const gptEnv = {
    GPT_ACTIONS_ENABLED: 'true',
    SUPABASE_URL: 'https://exampleproject.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
  };
  const supabase = async (url, init) => {
    rpcCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify([ROW]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = { GPT_ACTIONS_SERVICE: { fetch: (request) => handleGptActionsRequest(request, gptEnv, supabase) } };
  const mcpRequest = new Request('https://mcp.vishartattoo.com/mcp', { headers: { authorization: 'Bearer header.payload.signature' } });

  const result = await callPluginMcpTool(enquiryFull, { enquiry_id: ENQUIRY }, mcpRequest, env);

  assert.equal(rpcCalls.length, 1, 'one read, no extra tool or RPC call');
  assert.equal(rpcCalls[0].url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_get_enquiry_full');
  assert.deepEqual(result.reference_analyses, ANALYSES, 'the stored analysis reaches the model exactly as stored');
  assert.equal(result.reference_analyses.images[0].image, '1 of 2', 'photos keep their CRM numbering');
  assert.equal(result.idea, 'Cover up half arms just front', 'together with the client\'s original text');
});

await test('the tool description tells the model to use the analyses with the client text, unprompted', () => {
  const description = enquiryFull.definition.description;
  assert.equal(enquiryFull.name, 'crm_get_enquiry_full');
  assert.match(description, /The read for reviewing one enquiry/);
  assert.match(description, /reference_analyses\.images holds the stored vision-model analysis of each attached photo, numbered as in the CRM/);
  assert.match(description, /refer to photos by their number/);
  assert.match(description, /reference_analyses\.not_analysed names photos without an analysis/);
  assert.match(description, /use these together with the client's own text without being asked/);
  assert.match(description, /references, a cover-up or placement/);
  assert.match(description, /the photos and the client's words stay authoritative/);
  const consultation = tools.find((tool) => tool.operationId === 'getConsultationContext').definition.description;
  assert.match(consultation, /reference_analyses\.images holds the stored vision-model analysis/);
  const files = tools.find((tool) => tool.operationId === 'listEnquiryFiles').definition.description;
  assert.match(files, /already in crm_get_enquiry_full and crm_get_consultation_context as reference_analyses/);
});

await test('the guidance travels with the data: one note explains every photo', () => {
  // Server instructions are capped (test-mcp-plugin-tools), so the note is
  // in one note on top of the photo list the database returns.
  const sql = readFileSync('supabase/migrations/20261006090000_readable_reference_analyses.sql', 'utf8');
  assert.match(sql, /'note', 'Stored vision-model analysis of the client''s attached photos, not re-summarised\. Photos are numbered as in the CRM\./);
  assert.match(sql, /'image', p\.position \|\| ' of ' \|\| p\.total/, 'photos are numbered as in the CRM');
  assert.match(sql, /'not_analysed'/, 'photos without analysis are named');
  const helperUse = readFileSync('supabase/migrations/20261004170000_enquiry_full_reference_analyses.sql', 'utf8');
  assert.match(helperUse, /crm_private\.enquiry_reference_analyses\(e\.id\)/, 'gpt_get_enquiry_full uses the shared helper');
  assert.match(helperUse, /'reference_analyses', crm_private\.enquiry_reference_analyses\(v_enquiry_id\)/, 'the consultation context uses the same helper');
});

console.log(`MCP enquiry reference analyses: ${passes} passed`);
