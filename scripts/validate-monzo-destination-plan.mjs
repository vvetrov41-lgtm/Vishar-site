#!/usr/bin/env node
//
// Offline validation of a Monzo reusable destination plan.
//
// The plan is the operator input for
// scripts/monzo/provision-artist-payment-destinations.sql. Validating it here
// means a malformed or duplicated URL is caught before the protected
// production database gate is used at all.
//
// This script performs no network call, touches no database, and never prints
// a payment URL. Failures identify the offending entry by amount and index.
//
//   node scripts/validate-monzo-destination-plan.mjs <plan.json>
//   node scripts/validate-monzo-destination-plan.mjs --self-test

import { readFileSync } from 'node:fs';

const MONZO_URL_PATTERN = /^https:\/\/monzo\.com\/pay\/r\/[A-Za-z0-9_-]{4,255}$/;
const MAX_ENTRIES = 32;
const MAX_AMOUNT = 100000;

// Not a business rule, just the amounts the current duration policy can
// produce for a single session. A plan is still valid without all of them;
// this only reports which standard tiers a plan would leave unrouted.
export const STANDARD_SESSION_AMOUNTS = [50, 100, 150, 250];

export function validateMonzoDestinationPlan(plan) {
  const errors = [];
  const amounts = new Set();
  const urls = new Set();

  if (!Array.isArray(plan)) {
    return { ok: false, errors: ['the plan must be a JSON array'], amounts: [], missingStandardAmounts: [] };
  }
  if (plan.length === 0) errors.push('the plan is empty');
  if (plan.length > MAX_ENTRIES) errors.push(`the plan has more than ${MAX_ENTRIES} entries`);

  plan.forEach((entry, index) => {
    const where = `entry ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where}: must be an object with amount and payment_url`);
      return;
    }

    const extra = Object.keys(entry).filter((key) => key !== 'amount' && key !== 'payment_url');
    if (extra.length) errors.push(`${where}: unexpected field(s) ${extra.join(', ')}`);

    const amount = entry.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      errors.push(`${where}: amount must be a number`);
    } else if (amount <= 0 || amount > MAX_AMOUNT) {
      errors.push(`${where}: amount ${amount} is out of range`);
    } else if (Math.round(amount * 100) !== amount * 100) {
      errors.push(`${where}: amount ${amount} has more than two decimal places`);
    } else if (amounts.has(amount)) {
      errors.push(`${where}: amount ${amount} appears more than once`);
    } else {
      amounts.add(amount);
    }

    const url = typeof entry.payment_url === 'string' ? entry.payment_url.trim() : '';
    if (!MONZO_URL_PATTERN.test(url)) {
      // Deliberately does not echo the value back.
      errors.push(`${where}: payment_url is not an exact https://monzo.com/pay/r/... link`);
    } else if (urls.has(url)) {
      errors.push(`${where}: this Monzo URL is already used by another amount in the plan`);
    } else {
      urls.add(url);
    }
  });

  const sorted = [...amounts].sort((a, b) => a - b);
  return {
    ok: errors.length === 0,
    errors,
    amounts: sorted,
    missingStandardAmounts: STANDARD_SESSION_AMOUNTS.filter((amount) => !amounts.has(amount)),
  };
}

function selfTest() {
  const cases = [
    [[], false, 'empty plan'],
    [[{ amount: 50, payment_url: 'https://monzo.com/pay/r/aaaa1111' }], true, 'single valid entry'],
    [
      [
        { amount: 50, payment_url: 'https://monzo.com/pay/r/aaaa1111' },
        { amount: 50, payment_url: 'https://monzo.com/pay/r/bbbb2222' },
      ],
      false,
      'duplicate amount',
    ],
    [
      [
        { amount: 50, payment_url: 'https://monzo.com/pay/r/aaaa1111' },
        { amount: 100, payment_url: 'https://monzo.com/pay/r/aaaa1111' },
      ],
      false,
      'one URL reused across two amounts',
    ],
    [[{ amount: 50, payment_url: 'https://example.com/pay/r/aaaa1111' }], false, 'foreign host'],
    [[{ amount: 50, payment_url: 'https://monzo.com/pay/r/aaaa1111?x=1' }], false, 'query string'],
    [[{ amount: 0, payment_url: 'https://monzo.com/pay/r/aaaa1111' }], false, 'zero amount'],
    [[{ amount: 50.125, payment_url: 'https://monzo.com/pay/r/aaaa1111' }], false, 'sub-penny amount'],
    [
      [{ amount: 50, payment_url: 'https://monzo.com/pay/r/aaaa1111', artist_id: 'x' }],
      false,
      'artist chosen inside the plan',
    ],
    [
      [
        { amount: 250, payment_url: 'https://monzo.com/pay/r/dddd4444' },
        { amount: 600, payment_url: 'https://monzo.com/pay/r/eeee5555' },
        { amount: 750, payment_url: 'https://monzo.com/pay/r/ffff6666' },
      ],
      true,
      'additional future amounts need no catalogue schema change',
    ],
  ];

  let failures = 0;
  for (const [plan, expected, name] of cases) {
    const result = validateMonzoDestinationPlan(plan);
    if (result.ok !== expected) {
      failures += 1;
      console.error(`FAIL: ${name} (expected ok=${expected}, got ok=${result.ok})`);
      for (const error of result.errors) console.error(`  ${error}`);
    }
  }

  // A plan must never be able to name the artist: the artist is chosen by the
  // operator command, not by the file.
  const named = validateMonzoDestinationPlan([
    { amount: 50, payment_url: 'https://monzo.com/pay/r/aaaa1111', artist_slug: 'vladimir' },
  ]);
  if (named.ok) {
    failures += 1;
    console.error('FAIL: a plan must not be allowed to select the artist');
  }

  if (failures) {
    console.error(`Monzo destination plan validator: ${failures} failed`);
    process.exit(1);
  }
  console.log(`Monzo destination plan validator: ${cases.length + 1} cases passed`);
}

function main() {
  const [arg] = process.argv.slice(2);
  if (!arg || arg === '--self-test') return selfTest();

  let plan;
  try {
    plan = JSON.parse(readFileSync(arg, 'utf8'));
  } catch (error) {
    console.error(`Could not read a JSON plan from ${arg}: ${error.message}`);
    process.exit(1);
  }

  const result = validateMonzoDestinationPlan(plan);
  for (const error of result.errors) console.error(`error: ${error}`);
  if (!result.ok) {
    console.error('The destination plan is not safe to provision.');
    process.exit(1);
  }

  console.log(`Plan is valid: ${result.amounts.length} destination(s).`);
  console.log(`Amounts: ${result.amounts.map((amount) => `GBP ${amount}`).join(', ')}`);
  if (result.missingStandardAmounts.length) {
    console.log(
      `Note: no destination for standard single-session amount(s) ${result.missingStandardAmounts
        .map((amount) => `GBP ${amount}`)
        .join(', ')}. Deposits for those amounts will fail closed.`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
