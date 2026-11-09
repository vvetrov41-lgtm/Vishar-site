import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyTodayLineage } from './verify-today-db-release.mjs';
const valid = ' Local | Remote | Time\n 20261010080000 | 20261010080000 | t\n 20261010170000 | | t';
assert.equal(verifyTodayLineage(valid), '20261010170000');
// Captured format from the pinned CLI 2.110.0 in the production runner.
const markdown = ' Local | Remote | Time (UTC)\n `20261010080000` | `20261010080000` | `2026-10-10 08:00:00`\n `20261010170000` | ` ` | `2026-10-10 17:00:00`';
assert.equal(verifyTodayLineage(markdown), '20261010170000');
assert.throws(() => verifyTodayLineage(markdown.replaceAll('20261010080000', '20261009230000')));
assert.throws(() => verifyTodayLineage(markdown+'\n `20261010180000` | ` ` | time'));

for (const invalid of ['', valid.replaceAll('20261010080000','20261009230000'), valid+'\n 20261010180000 | | t', valid+'\n | 20261006140000 | t', valid.replace('20261010170000','20261005093649')]) {
  assert.throws(() => verifyTodayLineage(invalid));
}

const placementTransition = [
  ' Local | Remote | Time',
  ' 20261020090000 | 20261020090000 | t',
  ' 20261021074511 | 20261021074511 | t',
  ' 20261021090000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(placementTransition), '20261021090000');
assert.throws(() => verifyTodayLineage(placementTransition + '\n 20261021090100 | | t'));
assert.throws(() => verifyTodayLineage(placementTransition.replace(
  '20261021074511 | 20261021074511', '20261021074511 | '
)));

// Only the exact voice-note migration may follow the deployed database head.
const audioTransition = [
  ' Local | Remote | Time',
  ' 20261105165000 | 20261105165000 | t',
  ' 20261106010000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(audioTransition), '20261106010000');
for (const invalid of [
  audioTransition + '\n 20261106011000 | | t',
  audioTransition.replace('20261106010000 | |','20261106011000 | |'),
  audioTransition.replace('20261105165000 | 20261105165000','20261105165000 | '),
  audioTransition + '\n | 20261106020000 | t',
]) assert.throws(() => verifyTodayLineage(invalid));

// The consultation address fix is the sole permitted next DB migration.
const consultationAddress = ' Local | Remote | Time\n 20261109190000 | 20261109190000 | t\n 20261109220000 | | t';
assert.equal(verifyTodayLineage(consultationAddress), '20261109220000');
assert.throws(() => verifyTodayLineage(consultationAddress.replace('20261109220000 | |', '20261109221000 | |')));
assert.throws(() => verifyTodayLineage(consultationAddress + '\n 20261109230000 | | t'));
assert.throws(() => verifyTodayLineage(consultationAddress.replace('20261109190000 | 20261109190000', '20261109190000 | ')));

// The third-button candidate is the only migration allowed after the
// already-confirmed London consultation location fix.
const preparationButton = ' Local | Remote | Time\n 20261109220000 | 20261109220000 | t\n 20261109230000 | | t';
assert.equal(verifyTodayLineage(preparationButton),'20261109230000');
assert.throws(()=>verifyTodayLineage(preparationButton.replace('20261109230000 | |','20261109230100 | |')));
assert.throws(()=>verifyTodayLineage(preparationButton+'\n 20261109231000 | | t'));

const workflow = readFileSync('.github/workflows/deploy-private-production-database.yml','utf8');
for (const guard of ['backend-auth-today-database-only', 'GITHUB_REPOSITORY_OWNER', 'canonical_sha', 'Required exact-head workflow', 'Verify Today production lineage', 'verify-today-db-release.mjs', 'supabase db push --dry-run', 'Remote database is up to date.', 'DB_DEPLOY_ENABLED', 'DEPLOY_PRIVATE_CRM_DATABASE']) {
  assert.ok(workflow.includes(guard === 'DB_DEPLOY_ENABLED' ? 'CRM_PRODUCTION_DB_DEPLOY_ENABLED' : guard), guard);
}
assert.ok(!workflow.includes('--include-all'));
assert.ok(!workflow.includes('wrangler'));
console.log('Today database-only lineage and release boundaries passed');

const operator = readFileSync('.github/workflows/crm-host-split-operator.yml','utf8');
assert.ok(operator.includes('VITE_POSTHOG_HOST: eu.i.posthog.com'));
assert.ok(!operator.includes('vars.CRM_PRODUCTION_POSTHOG_HOST'));

// The reliability release cannot carry an extra migration or hide remote drift.
const shadow = ' Local | Remote | Time\n 20261020090000 | 20261020090000 | t\n 20261021074511 | | t';
assert.equal(verifyTodayLineage(shadow), '20261021074511');
for (const invalid of [
  shadow.replaceAll('20261020090000', '20261019200000'),
  shadow.replace('20261021074511', '20261021080000'),
  shadow + '\n 20261022090000 | | t',
  shadow + '\n | 20261020120000 | t',
  shadow.replace('20261021074511', '20261010170000'),
]) assert.throws(() => verifyTodayLineage(invalid));


// PR #1141: only the exact read-only Coexistence state migration may follow
// the deployed 20261030175000 production head.
const coexistenceTransition = [
  ' Local | Remote | Time',
  ' 20261030175000 | 20261030175000 | t',
  ' 20261101180000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(coexistenceTransition), '20261101180000');
for (const invalid of [
  coexistenceTransition + '\n 20261101181000 | | t',
  coexistenceTransition.replace('20261101180000 | |', '20261101190000 | |'),
  coexistenceTransition.replace('20261030175000 | 20261030175000', '20261030175000 | '),
  coexistenceTransition.replace('20261030175000 | 20261030175000', '20261030174000 | 20261030174000'),
  coexistenceTransition + '\n | 20261101181000 | t',
]) assert.throws(() => verifyTodayLineage(invalid));

// PR #1133 then PR #1140: two single-step releases, in order, with no
// skipped, extra, reordered or unknown migration.
const metaReconciliation = [
  ' Local | Remote | Time',
  ' 20261101180000 | 20261101180000 | t',
  ' 20261102010000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(metaReconciliation), '20261102010000');
const metaFunnel = [
  ' Local | Remote | Time',
  ' 20261101180000 | 20261101180000 | t',
  ' 20261102010000 | 20261102010000 | t',
  ' 20261102011000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(metaFunnel), '20261102011000');
for (const invalid of [
  metaReconciliation + '\n 20261102011000 | | t',
  metaReconciliation.replace('20261102010000 | |', '20261102011000 | |'),
  metaReconciliation.replace('20261101180000 | 20261101180000', '20261101180000 | '),
  metaReconciliation + '\n | 20261102005000 | t',
  metaFunnel.replace('20261102010000 | 20261102010000', '20261102010000 | '),
  metaFunnel + '\n 20261102012000 | | t',
]) assert.throws(() => verifyTodayLineage(invalid));


// Coexistence Option A: only the exact metadata-only once-per-onboarding
// migration is allowed after the actual production head.
const coexistenceSyncTransition = [
  ' Local | Remote | Time',
  ' 20261103010000 | 20261103010000 | t',
  ' 20261103070000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(coexistenceSyncTransition), '20261103070000');
for (const invalid of [
  coexistenceSyncTransition + '\n 20261103080000 | | t',
  coexistenceSyncTransition.replace('20261103070000 | |', '20261103071000 | |'),
  coexistenceSyncTransition.replace('20261103010000 | 20261103010000', '20261103010000 | '),
  coexistenceSyncTransition.replaceAll('20261103010000', '20261102210000'),
  coexistenceSyncTransition + '\n | 20261103090000 | t',
]) assert.throws(() => verifyTodayLineage(invalid));


// Exact release authorization for the preferred-channel lifecycle migration.
const preferredChannel = [
  ' Local | Remote | Time',
  ' 20261105165000 | 20261105165000 | t',
  ' 20261106010000 | 20261106010000 | t',
  ' 20261106090000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(preferredChannel), '20261106090000');
for (const invalid of [
  preferredChannel + '\n 20261106090500 | | t',
  preferredChannel.replace('20261106090000 | |','20261106091000 | |'),
  preferredChannel.replace('20261106010000 | 20261106010000','20261106010000 | '),
  preferredChannel + '\n | 20261106095000 | t',
]) assert.throws(() => verifyTodayLineage(invalid));

// Annual welcome preparation: only the exact additive disabled migration.
const annualWelcome = ' Local | Remote | Time\n 20261106180000 | 20261106180000 | t\n 20261106184619 | | t';
assert.equal(verifyTodayLineage(annualWelcome), '20261106184619');
for (const invalid of [
 annualWelcome + '\n 20261106190000 | | t',
 annualWelcome.replace('20261106184619 | |', '20261106184620 | |'),
 annualWelcome.replaceAll('20261106180000','20261106170000'),
 annualWelcome + '\n | 20261106183000 | t',
]) assert.throws(() => verifyTodayLineage(invalid));

// Staged v2 Meta Utility candidates never replace the active v1 registry.
// Only this single migration can follow the 072200 production head.
const reminderCandidate = [
  ' Local | Remote | Time',
  ' 20261107210000 | 20261107210000 | t',
  ' 20261107220000 | 20261107220000 | t',
  ' 20261107230000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(reminderCandidate), '20261107230000');
for (const invalid of [
  reminderCandidate + '\n 20261107231000 | | t',
  reminderCandidate.replace('20261107230000 | |', '20261107240000 | |'),
  reminderCandidate.replace('20261107220000 | 20261107220000', '20261107220000 | '),
  reminderCandidate + '\n | 20261107250000 | t',
]) assert.throws(() => verifyTodayLineage(invalid));

// Live v2 reminder promotion is permitted only after provider-preapproval
// and one-shot WhatsApp template smoke migration are already deployed.
const approvedReminderActivation = [
  ' Local | Remote | Time',
  ' 20261107230000 | 20261107230000 | t',
  ' 20261107233000 | 20261107233000 | t',
  ' 20261107240000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(approvedReminderActivation), '20261107240000');
for (const invalid of [
  approvedReminderActivation + '\n 20261107241000 | | t',
  approvedReminderActivation.replace('20261107240000 | |', '20261107242000 | |'),
  approvedReminderActivation.replace('20261107233000 | 20261107233000', '20261107233000 | '),
  approvedReminderActivation + '\n | 20261107250000 | t',
]) assert.throws(() => verifyTodayLineage(invalid));


// Consultation v2 Meta candidate is isolated from active v1 deliveries.
const consultationCardCandidate = [
  ' Local | Remote | Time',
  ' 20261107233000 | 20261107233000 | t',
  ' 20261107240000 | 20261107240000 | t',
  ' 20261107250000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(consultationCardCandidate), '20261107250000');
for (const invalid of [
  consultationCardCandidate + '\n 20261107251000 | | t',
  consultationCardCandidate.replace('20261107250000 | |', '20261107252000 | |'),
  consultationCardCandidate.replace('20261107240000 | 20261107240000', '20261107240000 | '),
]) assert.throws(() => verifyTodayLineage(invalid));


// Provider-approved consultation cards may only promote after the candidate.
const consultationCardPromotion = [
  ' Local | Remote | Time',
  ' 20261107240000 | 20261107240000 | t',
  ' 20261107250000 | 20261107250000 | t',
  ' 20261108000000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(consultationCardPromotion), '20261108000000');
for (const invalid of [
  consultationCardPromotion + '\n 20261108001000 | | t',
  consultationCardPromotion.replace('20261108000000 | |', '20261108003000 | |'),
  consultationCardPromotion.replace('20261107250000 | 20261107250000', '20261107250000 | '),
]) assert.throws(() => verifyTodayLineage(invalid));


// Stage first-person v3 consultation with two Meta quick replies, only after
// approved production v2. No zero-evidence activation in clean CI.
const consultV3Candidate = [
  ' Local | Remote | Time',
  ' 20261107250000 | 20261107250000 | t',
  ' 20261108000000 | 20261108000000 | t',
  ' 20261108010000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(consultV3Candidate), '20261108010000');
for (const invalid of [
  consultV3Candidate + '\n 20261108012000 | | t',
  consultV3Candidate.replace('20261108010000 | |', '20261108020000 | |'),
  consultV3Candidate.replace('20261108000000 | 20261108000000', '20261108000000 | '),
]) assert.throws(() => verifyTodayLineage(invalid));


// Kristina's 2026-11-03 notice must be accepted before a booking can persist.
// Only one safe, pre-reviewed consent allowlist migration may be pending.
const kristinaPrivacyRepair = [
  ' Local | Remote | Time',
  ' 20261108000000 | 20261108000000 | t',
  ' 20261108010000 | 20261108010000 | t',
  ' 20261108015000 | | t',
].join('\n');
assert.equal(verifyTodayLineage(kristinaPrivacyRepair), '20261108015000');
for(const invalid of [
  kristinaPrivacyRepair + '\n 20261108020000 | | t',
  kristinaPrivacyRepair.replace('20261108015000 | |','20261108020000 | |'),
  kristinaPrivacyRepair.replace('20261108010000 | 20261108010000','20261108010000 | '),
]) assert.throws(()=>verifyTodayLineage(invalid));
