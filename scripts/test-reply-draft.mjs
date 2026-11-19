import assert from 'node:assert/strict';
import { handleReplyDraft, isReplyDraftPath } from '../workers/routes/reply-draft.js';
import { buildDraftInput, diagnoseDraft, selectExamples } from '../workers/lib/ai/reply-draft.js';
import { resolveTask } from '../workers/lib/ai/tasks.js';

const origin = 'https://crm.vishartattoo.com';
const url = 'https://api.vishartattoo.com/crm/reply-draft';
const conversation = '11111111-1111-4111-8111-111111111111';
const token = 'test.operator.session.token.abcdefghijklmnopqrstuvwxyz';
const env = { REPLY_DRAFTS_ENABLED: 'true',
  SUPABASE_URL: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake_for_unit_tests' };
const context = {
  channel: 'whatsapp', artist: 'Vladimir', client_first_name: 'Kamal', whatsapp_window_open: true,
  rates: { currency: 'GBP', hourly_rate: 140, full_day_rate: 980, full_day_hours: 7 },
  studio: { name: 'Studio', address: 'Somewhere' },
  messages: [{ direction: 'inbound', text: 'How much would a half sleeve cost?', at: '2026-11-19T08:00:00Z' }],
  examples: [
    { channel: 'whatsapp', client: 'Where is the studio?', reply: 'West Kensington mate' },
    { channel: 'whatsapp', client: 'What are your prices for a sleeve?', reply: 'Hey mate! £140 per hour 🙌🏻 We did 14 and 15 November' },
  ],
};
const req = (body, headers = {}) => new Request(url, { method: 'POST', headers: {
  Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers,
}, body: JSON.stringify(body) });
const okFetch = (data = context) => async (input, options) => {
  assert.equal(new URL(input).pathname, '/rest/v1/rpc/get_reply_draft_context');
  assert.equal(options.headers.authorization, 'Bearer ' + token);
  assert.deepEqual(JSON.parse(options.body), { p_conversation_id: conversation });
  return Response.json(data);
};
let count = 0;
async function test(name, fn) { try { await fn(); count++; } catch (e) { console.error('FAIL ' + name, e); process.exitCode = 1; } }

await test('exact path only', () => {
  assert.equal(isReplyDraftPath(new Request(url)), true);
  assert.equal(isReplyDraftPath(new Request(url + '/send')), false);
});
await test('task is registered with Gemma first and a Qwen fallback', () => {
  const plan = resolveTask({}, 'reply_draft', new Set(['workers_ai', 'qwen', 'openai']));
  assert.deepEqual(plan.chain.map((c) => c.id ?? c), ['workers_ai', 'qwen']);
});
await test('disabled unless the flag is exactly true', async () => {
  for (const value of [undefined, 'false', 'TRUE']) {
    const res = await handleReplyDraft(req({ conversation_id: conversation }), { ...env, REPLY_DRAFTS_ENABLED: value });
    assert.equal(res.status, 404);
  }
});
await test('origin, auth and body are checked before any database call', async () => {
  const never = async () => { throw new Error('must not fetch'); };
  assert.equal((await handleReplyDraft(req({ conversation_id: conversation }, { Origin: 'https://evil.example' }), env, { fetchImpl: never })).status, 403);
  assert.equal((await handleReplyDraft(req({ conversation_id: conversation }, { Authorization: 'bad' }), env, { fetchImpl: never })).status, 401);
  assert.equal((await handleReplyDraft(req({ conversation_id: conversation, artist_id: conversation }), env, { fetchImpl: never })).status, 400);
  assert.equal((await handleReplyDraft(req({ conversation_id: 'nope' }), env, { fetchImpl: never })).status, 400);
});
await test('a grounded draft is returned and nothing is sent', async () => {
  let input;
  const res = await handleReplyDraft(req({ conversation_id: conversation }), env, {
    fetchImpl: okFetch(),
    runTask: async (_env, task, payload, options) => {
      assert.equal(task, 'reply_draft');
      input = JSON.parse(payload.input);
      const json = { draft: 'Hey Kamal! I charge £140 per hour or £980 for a full day (7 hours) 🙌🏻' };
      assert.equal(options.validateJson(json), true);
      return { ok: true, json };
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, draft: 'Hey Kamal! I charge £140 per hour or £980 for a full day (7 hours) 🙌🏻' });
  assert.equal(input.untrusted_data.voice_examples[0].client, 'What are your prices for a sleeve?');
  assert.equal(input.untrusted_data.studio, 'Studio');
  assert.equal(JSON.stringify(input).includes('Somewhere'), false, 'the address is not sent to the model');
});
await test('numbers that only an example carries are rejected', async () => {
  assert.equal(diagnoseDraft({ draft: 'We could do 14 and 15 November' }, context), 'ungrounded_number');
  assert.equal(diagnoseDraft({ draft: 'Around 3 sessions I think' }, context), 'ungrounded_number');
  assert.equal(diagnoseDraft({ draft: 'Send the deposit and you are booked' }, context), 'unsafe');
  assert.equal(diagnoseDraft({ draft: 'See https://example.test' }, context), 'unsafe');
  assert.equal(diagnoseDraft({ draft: 'ok', extra: 1 }, context), 'shape');
  const res = await handleReplyDraft(req({ conversation_id: conversation }), env, {
    fetchImpl: okFetch(), runTask: async () => ({ ok: true, json: { draft: 'Sure, 2-3 sessions' } }),
  });
  assert.equal(res.status, 503);
});
await test('closed WhatsApp window is reported before any model call', async () => {
  const res = await handleReplyDraft(req({ conversation_id: conversation }), env, {
    fetchImpl: okFetch({ ...context, whatsapp_window_open: false }),
    runTask: async () => { throw new Error('must not draft'); },
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'whatsapp_window_closed' });
});
await test('Instagram has no WhatsApp window; no client text means nothing to answer', async () => {
  const ig = { ...context, channel: 'instagram', whatsapp_window_open: null };
  const ok = await handleReplyDraft(req({ conversation_id: conversation }), env, {
    fetchImpl: okFetch(ig), runTask: async () => ({ ok: true, json: { draft: 'Hey! £140 per hour' } }),
  });
  assert.equal(ok.status, 200);
  const none = await handleReplyDraft(req({ conversation_id: conversation }), env, {
    fetchImpl: okFetch({ ...ig, messages: [{ direction: 'outbound', text: 'Hi!' }] }),
    runTask: async () => { throw new Error('must not draft'); },
  });
  assert.equal(none.status, 422);
});
await test('database denial maps to 403', async () => {
  const res = await handleReplyDraft(req({ conversation_id: conversation }), env, { fetchImpl: async () => new Response('{}', { status: 403 }) });
  assert.equal(res.status, 403);
});
await test('long conversations are trimmed oldest first to fit the model budget', () => {
  const long = { ...context, messages: Array.from({ length: 20 }, (_, i) => ({ direction: i % 2 ? 'outbound' : 'inbound', text: `m${i} ` + 'x'.repeat(590) })) };
  const input = buildDraftInput(long, 6000);
  assert.ok(input.length <= 6000);
  const kept = JSON.parse(input).untrusted_data.conversation;
  assert.ok(kept.at(-1).text.startsWith('m19'));
  assert.ok(kept.length < 20);
});
await test('examples are picked by similarity to the newest client text', () => {
  const picked = selectExamples(context.examples, 'Where exactly is your studio?', 1);
  assert.equal(picked[0].reply, 'West Kensington mate');
});
await test('CORS preflight only for CRM origins', async () => {
  const options = await handleReplyDraft(new Request(url, { method: 'OPTIONS', headers: { Origin: origin } }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), origin);
});

console.log(`reply draft: ${count} tests passed`);
