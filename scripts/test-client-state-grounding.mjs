#!/usr/bin/env node
// Regression fixtures for invented numbers in the CRM client brief.
// The cases mirror production briefs from 2026-09-26..10-02 (sanitized).
import assert from 'node:assert/strict';
import { groundClientStateV2 } from '../workers/lib/ai/client-state-schema.js';

const brief = (overrides = {}) => ({
  project_summary: null, placement: null, style: null, colour: null, size: null,
  cover_up_context: null, constraints: [], decisions_made: [], open_questions: [],
  promises_to_client: [], last_interaction: null, discussed: {}, ...overrides,
});
const answer = (summary, overrides) => ({ summary, brief: brief(overrides), reply_state: 'unclear', next_action: {} });
const source = (idea) => JSON.stringify({ untrusted_client_data: { enquiries: [{ idea }] } });

let passes = 0;
function test(name, fn) {
  try { fn(); passes += 1; } catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}

test('an invented size disagreement is dropped (prompt example copied as fact)', () => {
  const out = groundClientStateV2(answer('Full sleeve cover-up enquiry.', {
    size: 'Full sleeve',
    open_questions: ['Size: 10 cm earlier, 15 cm in the newest message - confirm', 'Which style?'],
  }), source('Full sleeve, cover up. Sword unsheathed, memento mori.'));
  assert.deepEqual(out.brief.open_questions, ['Which style?']);
  assert.equal(out.brief.size, 'Full sleeve');
});

test('a disagreement whose numbers are both in the data is kept', () => {
  const out = groundClientStateV2(answer('Outer upper arm piece.', {
    open_questions: ['Size: 15 - 20 cm in the form, 25 cm in the latest message - confirm'],
  }), source('15 - 20cm on the outer upper left arm. Actually maybe 25 cm.'));
  assert.equal(out.brief.open_questions.length, 1);
});

test('an invented date in the summary is removed sentence by sentence', () => {
  const out = groundClientStateV2(answer(
    'Client wants three tattoos on shoulders and forearm. Client is available on the 18th of November.',
    {}), source('3 tattoos, 5cm - 6cm each shoulder, 10cm 12cm forearm. Preferred timing: November 17th'));
  assert.equal(out.summary, 'Client wants three tattoos on shoulders and forearm.');
});

test('an invented budget in a field becomes null, the stated size stays', () => {
  const out = groundClientStateV2(answer('Neck piece.', { size: '20 x 20', constraints: ['Budget about £400'] }),
    source('Side of neck, 20 x 20 i think. Can you provide a price range'));
  assert.equal(out.brief.size, '20 x 20');
  assert.deepEqual(out.brief.constraints, []);
});

test('a summary made only of invented numbers fails closed', () => {
  assert.equal(groundClientStateV2(answer('Quote is 3 sessions at 800.', {}), source('Jungle sleeve, jaguar and crocodile.')), null);
});

test('decimal and comma forms of the same number match', () => {
  const out = groundClientStateV2(answer('About 7.5 cm.', { size: '7,5 cm' }), source('around 7.5cm'));
  assert.equal(out.brief.size, '7,5 cm');
});

test('invalid input fails closed', () => {
  assert.equal(groundClientStateV2(null, 'x'), null);
  assert.equal(groundClientStateV2(answer('ok', {}), null), null);
});

console.log(`client-state grounding: ${passes} passed`);
