import { readFileSync, writeFileSync } from 'node:fs';

function patch(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

const monzoIds = [
  'listMonzoReconciliationCandidates',
  'matchMonzoReconciliationCandidate',
  'ignoreMonzoReconciliationCandidate',
  'confirmMonzoReconciliationCandidate',
];

patch('supabase/tests/050_rls_roles.sql', (text) => {
  if (text.includes("'public.gpt_list_monzo_reconciliation_candidates()'")) return text;
  const marker = "  ('public.confirm_monzo_reconciliation_candidate(uuid)', false, true, false),\n";
  if (!text.includes(marker)) throw new Error('ACL insertion marker not found');
  const rows = [
    "  ('public.gpt_list_monzo_reconciliation_candidates()', false, true, false),",
    "  ('public.gpt_match_monzo_reconciliation_candidate(uuid,uuid)', false, true, false),",
    "  ('public.gpt_ignore_monzo_reconciliation_candidate(uuid)', false, true, false),",
    "  ('public.gpt_confirm_monzo_reconciliation_candidate(uuid)', false, true, false),",
    '',
  ].join('\n');
  return text.replace(marker, marker + rows);
});

const longConfirmDescription = 'This is the separate settlement action. Use it only after the user explicitly confirms the matched candidate and payment request. The backend revalidates verified Monzo evidence and records the immutable ledger transaction.';
const shortConfirmDescription = 'Separate settlement action. Use only after explicit user confirmation; the backend revalidates verified Monzo evidence before recording the immutable ledger transaction.';

patch('docs/gpt-actions/openapi.production.operations.yaml', (text) =>
  text.replace(longConfirmDescription, shortConfirmDescription));

const monzoOpenApi = `  /v1/payments/monzo/reconciliation:\n    get:\n      operationId: listMonzoReconciliationCandidates\n      summary: List Monzo payments that require reconciliation review\n      description: Returns only artist-scoped, PII-minimised CRM candidate context. Raw Monzo transaction, event and account identifiers are never exposed.\n      x-openai-isConsequential: false\n      responses: {'200': {description: Monzo reconciliation candidates}}\n\n  /v1/payments/monzo/reconciliation/{candidate_id}/match:\n    post:\n      operationId: matchMonzoReconciliationCandidate\n      summary: Match a Monzo candidate to a CRM payment request without settling it\n      description: This action only records the proposed candidate-to-request match. It does not mark any payment paid. Settlement requires a separate explicit Confirm action.\n      x-openai-isConsequential: true\n      parameters:\n        - {name: candidate_id, in: path, required: true, schema: {type: string, format: uuid}}\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              additionalProperties: false\n              required: [payment_request_id]\n              properties:\n                payment_request_id: {type: string, format: uuid}\n      responses: {'200': {description: Non-financial match result}, '403': {description: Candidate or request is outside the GPT artist scope}}\n\n  /v1/payments/monzo/reconciliation/{candidate_id}/ignore:\n    post:\n      operationId: ignoreMonzoReconciliationCandidate\n      summary: Explicitly ignore a Monzo reconciliation candidate\n      description: Ignore is non-financial and never creates a payment ledger transaction.\n      x-openai-isConsequential: true\n      parameters:\n        - {name: candidate_id, in: path, required: true, schema: {type: string, format: uuid}}\n      requestBody: {required: true, content: {application/json: {schema: {type: object, additionalProperties: false, properties: {}}}}}\n      responses: {'200': {description: Ignored candidate result}, '403': {description: Candidate is outside the GPT artist scope}}\n\n  /v1/payments/monzo/reconciliation/{candidate_id}/confirm:\n    post:\n      operationId: confirmMonzoReconciliationCandidate\n      summary: Confirm an already matched Monzo payment\n      description: ${shortConfirmDescription}\n      x-openai-isConsequential: true\n      parameters:\n        - {name: candidate_id, in: path, required: true, schema: {type: string, format: uuid}}\n      requestBody: {required: true, content: {application/json: {schema: {type: object, additionalProperties: false, properties: {}}}}}\n      responses: {'200': {description: Confirmed payment result}, '403': {description: Candidate is outside the GPT artist scope}}\n\n`;

patch('docs/gpt-actions/openapi.production.yaml', (text) => {
  if (monzoIds.every((id) => text.includes(`operationId: ${id}`))) return text;
  const marker = "      responses: {'200': {description: Manual payment result}}\n\n  /v1/enquiries/{enquiry_id}/whatsapp:\n";
  if (!text.includes(marker)) throw new Error('canonical OpenAPI insertion marker not found');
  return text
    .replace('version: 2.1.0-production', 'version: 2.2.0-production')
    .replace(marker, "      responses: {'200': {description: Manual payment result}}\n\n" + monzoOpenApi + "  /v1/enquiries/{enquiry_id}/whatsapp:\n");
});

patch('scripts/test-gpt-openapi-split.mjs', (text) => {
  let next = text
    .replace("assert.equal(canonical.length, 55, 'canonical GPT schema must keep exactly 55 operations');", "assert.equal(canonical.length, 59, 'canonical GPT schema must keep exactly 59 operations');")
    .replace("assert.equal(operationsIds.length, 20, 'operations ChatGPT-import schema must contain exactly 20 operations');", "assert.equal(operationsIds.length, 24, 'operations ChatGPT-import schema must contain exactly 24 operations');")
    .replace("assert.equal(new Set(combined).size, 55, 'split schemas must not duplicate operation IDs');", "assert.equal(new Set(combined).size, 59, 'split schemas must not duplicate operation IDs');")
    .replace("assert.deepEqual([...combined].sort(), [...canonical].sort(), 'split schemas must cover the exact canonical 55-operation surface');", "assert.deepEqual([...combined].sort(), [...canonical].sort(), 'split schemas must cover the exact canonical 59-operation surface');")
    .replace("for (const id of ['listAppointments', 'recordManualPayment', 'getProjectFinance', 'listActivity']) assert.ok(operationsIds.includes(id));", "for (const id of ['listAppointments', 'recordManualPayment', 'getProjectFinance', 'listActivity', ...monzoIds]) assert.ok(operationsIds.includes(id));\nfor (const id of monzoIds) {\n  assert.ok(!coreIds.includes(id), `${id} must not appear in Core`);\n  assert.ok(!communicationsIds.includes(id), `${id} must not appear in Communications`);\n}")
    .replace("console.log('GPT OpenAPI split tests passed: 25 core + 20 operations + 10 communications, three domains, exact 55-operation coverage, five-slot minimum headroom and guarded DB-free rollout.');", "console.log('GPT OpenAPI split tests passed: 25 core + 24 operations + 10 communications, three domains, exact 59-operation coverage and guarded rollout separation.');");

  if (!next.includes('const monzoIds = [')) {
    const marker = "const combined = [...coreIds, ...operationsIds, ...communicationsIds];\n";
    if (!next.includes(marker)) throw new Error('split test Monzo ID marker not found');
    next = next.replace(marker, marker + `const monzoIds = [\n  'listMonzoReconciliationCandidates',\n  'matchMonzoReconciliationCandidate',\n  'ignoreMonzoReconciliationCandidate',\n  'confirmMonzoReconciliationCandidate',\n];\n`);
  }
  return next;
});

console.log('GPT Monzo canonical files patched deterministically.');
