// Structural and semantic checks for CRM AI eval fixtures.
//
// A check never compares prose. It asks whether the answer respects facts the
// fixture makes unambiguous: an action the facts forbid, a waiting side the
// timeline decides, a field the input states. Each failure is a short code.

import { validateClientStateAnalysis } from '../../workers/lib/ai/client-state-schema.js';
import { normalizeEnquiryAnalysis, validateEnquiryAnalysis } from '../../workers/lib/ai/enquiry-schema.js';

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');

function clientStateText(answer) {
  return [answer.summary, answer.next_action?.reason, answer.next_action?.draft_reply,
    ...(answer.brief?.open_questions ?? []), ...(answer.brief?.constraints ?? []),
    answer.brief?.size, answer.brief?.project_summary].map(lower).join('\n');
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
    if (action.missing_information.map(lower).includes(key)) failures.push(`missing_has:${key}`);
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
    if (!valid.missing_information.includes(key)) failures.push(`missing_lacks:${key}`);
  }
  for (const key of expect.missing_excludes ?? []) {
    if (valid.missing_information.includes(key)) failures.push(`missing_has:${key}`);
  }
  for (const needle of expect.draft_excludes ?? []) {
    if (lower(valid.draft_reply).includes(lower(needle))) failures.push(`draft_has:${needle}`);
  }
  return { valid: true, failures };
}

export function checkAnswer(task, answer, expect) {
  return task === 'enquiry_intake' ? checkEnquiry(answer, expect) : checkClientState(answer, expect);
}
