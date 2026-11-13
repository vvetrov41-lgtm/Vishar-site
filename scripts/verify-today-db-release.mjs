import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A deliberately single-migration automatic path; other releases use dispatch.
export function verifyTodayLineage(source) {
  const rows = source.replaceAll('`', '').split('\n').map((line) => line.match(/^\s*(\d*)\s*\|\s*(\d*)\s*\|/)).filter(Boolean);
  if (!rows.length) throw new Error('No migration state; refusing production mutation');
  const local = rows.map((r) => r[1]).filter(Boolean);
  const remote = rows.map((r) => r[2]).filter(Boolean);
  const approvedTransitions = new Map([
    ['20261010080000', '20261010170000'],
    // Reliability PR #1118: only the attention report body changes.
    ['20261020090000', '20261021074511'],
    // Placement reconciliation PR #1119, only after the reliability migration is live.
    ['20261021074511', '20261021090000'],
    // PR #1141: strictly bounded read-only WhatsApp Coexistence state.
    ['20261030175000', '20261101180000'],
    // PR #1133: consented Meta ad IDs and conversion-day reconciliation.
    ['20261101180000', '20261102010000'],
    // PR #1140: aggregate-only Meta funnel RPC, only after #1133 is live.
    ['20261102010000', '20261102011000'],
    // CRM Meta funnel: only the next privacy-hardened monthly totals migration
    // after studio share, premium day rate and guest commission are live.
    ['20261102210000', '20261103010000'],
    // PR #1151: only metadata for a once-only Coexistence sync, no chat data.
    ['20261103010000', '20261103070000'],
    // PR #1152: one Today-pulse correction; exclude transfers linked to settled receipts.
    ['20261103070000', '20261103120000'],
    // Today: suppress intentional cancels and credit real Gmail history checks.
    ['20261103120000', '20261103150000'],
    // Voice notes: only one private queue migration after the live head.
    ['20261105165000', '20261106010000'],
    // Client channel routing: one verified migration after WhatsApp audio.
    ['20261106010000', '20261106090000'],
    // Existing approved WhatsApp templates: map URL joins the address variable.
    ['20261106090000', '20261106180000'],
    // PR #1171: annual Instagram welcome, both account switches remain off.
    ['20261106180000', '20261106184619'],
    // Meta rejects line breaks inside WhatsApp template body parameters.
    ['20261107080000', '20261107210000'],
    // Keep in-person WhatsApp consultation location aligned with Gmail.
    ['20261107210000', '20261107220000'],
    // Stage v2 provider candidates; active WhatsApp v1 delivery stays untouched.
    ['20261107220000', '20261107230000'],
    // One-shot Meta template smoke tests never create fake CRM appointments.
    ['20261107230000', '20261107233000'],
    // Promote only provider-approved first-person WhatsApp reminder v2 cards.
    ['20261107233000', '20261107240000'],
    // Stage consultation first-person card without switching live v1 sends.
    ['20261107240000', '20261107250000'],
    // Promote only after live Meta approval and no in-flight v1 consultation.
    ['20261107250000', '20261108000000'],
    // New consultation Meta candidate and one-use quick-reply capabilities.
    ['20261108000000', '20261108010000'],
    // Restore Kristina's consented booking flow: her 2026-11-03 notice is live
    // in the Worker but missing from the SQL durable-intake version allowlist.
    ['20261108010000', '20261108015000'],
    // Instagram booking cancellation and lifecycle after live Gmail/WhatsApp migrations.
    ['20261109001000', '20261109140000'],
    // Promote six reviewed WhatsApp templates after Meta approval and new sender CI.
    ['20261109140000', '20261109170000'],
    // Expand existing once-only Meta smoke test to both approved tattoo reminders.
    ['20261109170000', '20261109180000'],
    // Stage approval-gated reminder button templates; no live switch.
    ['20261109180000', '20261109190000'],
    // Consultation reminder location only: remove York House, retain delivery contracts.
    ['20261109190000', '20261109220000'],
    // Stage the FAQ URL as the third 72h WhatsApp button; live v3 stays active.
    ['20261109220000', '20261109230000'],
    // Restore the consultation venue split and avoid the wrong WhatsApp static link.
    ['20261109230000', '20261110020000'],
    // New York House WhatsApp proposal identities and fail-closed v2 protection.
    ['20261110020000', '20261110095000'],
    // Correct third-person Meta aftercare/check-in and safeguard existing
    // immediate / 24h timing. Stage v2; v1 falls back to first-person Email.
    ['20261110095000', '20261110200000'],
    // Promote ONLY the two verified York House Meta Utility cards.
    ['20261110200000', '20261111060000'],
    // First-person outbound audit: one guarded DB migration; no client replays.
    ['20261111060000', '20261111072000'],
    // Switch only genuinely Meta-approved first-person post-session identities.
    ['20261111072000', '20261111083000'],
    // Add Vladimir-only cash preference to tattoo booking email and stage
    // an unapproved Meta v3 candidate. The live WhatsApp v2 remains active.
    ['20261112133000', '20261112164000'],
    // PR #1235: a definitive WhatsApp refusal is terminal at once; one function.
    ['20261112164000', '20261112200000'],
    // PR #1246: retry of still-current lifecycle messages after an integration
    // outage, only after the refusal migration is live.
    ['20261112200000', '20261112210000'],
    // Meta-approved Vladimir tattoo cash Utility v3; only after PR #1246.
    ['20261112210000', '20261112220000'],
    // Post-activation Gmail client excerpts, scoped to known artist/client
    // and no old enquiry AI. Exactly one additive migration after cash v3.
    ['20261112220000', '20261113010000'],
    // Audit: buffer signed WhatsApp failed statuses before send acknowledgement.
    ['20261113010000', '20261113100000'],
    // Profile-only ChatGPT Plugin OAuth status and in-app reconnect warning;
    // one additive migration following the confirmed WhatsApp status-race fix.
    ['20261113100000', '20261113110000'],
  ]);
  const expectedPending = approvedTransitions.get(remote.at(-1));
  if (!expectedPending) throw new Error('Production migration head changed');
  if (remote.some((version) => !local.includes(version))) throw new Error('Production contains unknown migration history');
  const pending = local.filter((version) => !remote.includes(version));
  if (pending.length !== 1 || pending[0] !== expectedPending) throw new Error('Expected exactly the approved ordered single migration');
  if (pending[0] <= remote.at(-1)) throw new Error('Out-of-order production migration');
  return pending[0];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Validated production head and sole pending migration: ${verifyTodayLineage(readFileSync(process.argv[2], 'utf8'))}`);
}
