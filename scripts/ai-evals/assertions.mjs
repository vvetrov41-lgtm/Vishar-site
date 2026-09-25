// Structural and semantic checks for CRM AI eval fixtures.
//
// A check never compares prose. It asks whether the answer respects facts the
// fixture makes unambiguous: an action the facts forbid, a waiting side the
// timeline decides, a field the input states. Each failure is a short code.

import { validateClientStateAnalysis } from '../../workers/lib/ai/client-state-schema.js';
import { normalizeEnquiryAnalysis, validateEnquiryAnalysis } from '../../workers/lib/ai/enquiry-schema.js';
import { normalizeReferenceImageAnalysis, validateReferenceImageAnalysis } from '../../workers/lib/ai/reference-image-schema.js';

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');

function collectText(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectText(item, output);
  }
  return output;
}

function clientStateText(answer) {
  // Scan every free-text-bearing part of the validated answer. Eval exclusions
  // must catch a false claim wherever the model places it, including arrays
  // such as decisions_made/promises_to_client and discussed values.
  return collectText({
    summary: answer.summary,
    brief: answer.brief,
    next_action: {
      reason: answer.next_action?.reason,
      draft_reply: answer.next_action?.draft_reply,
    },
  }).map(lower).join('\n');
}

function missingTokens(value) {
  const phrase = lower(value)
    .normalize('NFKC')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!phrase) return [];
  const stem = (token) => {
    if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
    if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
    return token;
  };
  return phrase.split(' ').map(stem).filter(Boolean);
}

function sameMissingConcept(left, right) {
  const a = new Set(missingTokens(left));
  const b = new Set(missingTokens(right));
  if (!a.size || !b.size) return false;
  const subset = (x, y) => [...x].every((token) => y.has(token));
  // Treat "reference", "reference image" and "reference images" as the same
  // missing concept, likewise "size" and "approximate size". This keeps the
  // eval semantic instead of depending on a model's separator/plural choice.
  return subset(a, b) || subset(b, a);
}

// A claim detector looks for an assertion, not a word. "Deposit paid" is a
// claim; "not yet paid", "unpaid", "once paid" and "awaiting payment" are not.
const NEGATION_BEFORE = /(?:\bnot(?: yet)?|n't|\bun|\byet to be|\bawaiting|\bpending|\buntil|\bonce|\bbefore|\bwhen|\bif|\bwhether|\bno)\s*$/;
const CLAIMS = Object.freeze({
  deposit_paid: /\bpaid\b/g,
});

function assertsClaim(text, claim) {
  const pattern = CLAIMS[claim];
  if (!pattern) return false;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    const sentenceStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('\n'));
    if (!NEGATION_BEFORE.test(before.slice(sentenceStart + 1))) return true;
  }
  return false;
}

export function checkClientState(answer, expect = {}) {
  const valid = validateClientStateAnalysis(answer);
  if (!valid) return { valid: false, failures: ['schema_invalid'] };
  const failures = [];
  const { brief, next_action: action } = valid;
  const text = clientStateText(valid);
  const draft = lower(action.draft_reply);

  if (expect.stage_in && !expect.stage_in.includes(brief.stage)) failures.push(`stage:${brief.stage}`);
  if (expect.stage_not_in?.includes(brief.stage)) failures.push(`stage:${brief.stage}`);
  if (expect.waiting_on_in && !expect.waiting_on_in.includes(brief.waiting_on)) failures.push(`waiting_on:${brief.waiting_on}`);
  if (expect.action_in && !expect.action_in.includes(action.action_type)) failures.push(`action:${action.action_type}`);
  if (expect.action_not_in?.includes(action.action_type)) failures.push(`action:${action.action_type}`);
  if (expect.missing_nonempty && action.missing_information.length === 0) failures.push('missing_empty');
  for (const key of expect.missing_excludes ?? []) {
    if (action.missing_information.some((item) => sameMissingConcept(item, key))) failures.push(`missing_has:${key}`);
  }
  for (const key of expect.brief_nonnull ?? []) {
    if (brief[key] === null) failures.push(`brief_null:${key}`);
  }
  if (expect.draft_absent_for?.includes(action.action_type) && action.draft_reply !== null) failures.push('draft_on_commitment');
  for (const needle of expect.text_excludes ?? []) {
    if (text.includes(lower(needle))) failures.push(`text_has:${needle}`);
  }
  for (const needle of expect.draft_excludes ?? []) {
    if (draft.includes(lower(needle))) failures.push(`draft_has:${needle}`);
  }
  for (const claim of expect.claims_absent ?? []) {
    if (assertsClaim(text, claim)) failures.push(`claims:${claim}`);
  }
  for (const group of expect.mentions_any ?? []) {
    if (!group.some((needle) => text.includes(lower(needle)))) failures.push(`mentions:${group[0]}`);
  }
  for (const [key, allowed] of Object.entries(expect.discussed_status ?? {})) {
    if (!allowed.includes(brief.discussed[key]?.status)) failures.push(`discussed:${key}`);
  }
  return { valid: true, failures };
}

export function checkEnquiry(answer, expect = {}) {
  const valid = validateEnquiryAnalysis(normalizeEnquiryAnalysis(answer));
  if (!valid) return { valid: false, failures: ['schema_invalid'] };
  const failures = [];
  for (const [key, allowed] of Object.entries(expect.field_status_in ?? {})) {
    if (!allowed.includes(valid.fields[key]?.status)) failures.push(`status:${key}`);
  }
  for (const [key, value] of Object.entries(expect.field_value ?? {})) {
    if (valid.fields[key]?.value !== value) failures.push(`value:${key}`);
  }
  for (const key of expect.missing_includes ?? []) {
    if (!valid.missing_information.some((item) => sameMissingConcept(item, key))) failures.push(`missing_lacks:${key}`);
  }
  for (const key of expect.missing_excludes ?? []) {
    if (valid.missing_information.some((item) => sameMissingConcept(item, key))) failures.push(`missing_has:${key}`);
  }
  for (const needle of expect.draft_excludes ?? []) {
    if (lower(valid.draft_reply).includes(lower(needle))) failures.push(`draft_has:${needle}`);
  }
  return { valid: true, failures };
}

export const __testing = Object.freeze({ assertsClaim });

export function checkVision(answer, expect = {}) {
  const valid = validateReferenceImageAnalysis(normalizeReferenceImageAnalysis(answer));
  if (!valid) return { valid: false, failures: ['schema_invalid'] };
  const failures = [];
  if (expect.image_kind_in && !expect.image_kind_in.includes(valid.image_kind)) failures.push('image_kind');
  if (expect.existing_tattoo_visible_not !== undefined
    && valid.existing_tattoo_visible === expect.existing_tattoo_visible_not) failures.push('existing_tattoo_visible');
  return { valid: true, failures };
}

export function checkAnswer(task, answer, expect) {
  if (task === 'vision_reference_extraction') return checkVision(answer, expect);
  return task === 'enquiry_intake' ? checkEnquiry(answer, expect) : checkClientState(answer, expect);
}
