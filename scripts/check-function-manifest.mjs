#!/usr/bin/env node
// Compares the full definitions of CRM database functions with the committed
// manifest, supabase/function-manifest.tsv.
//
//   --compare <file>   Compare a manifest produced by scripts/function-manifest.sql
//                      on a database built from the migrations (CI).
//   --write <file>     Replace the committed manifest with that file (local use,
//                      after a migration intentionally changes a function).
//   --production       Read production through the Supabase Management API in
//                      read-only mode and compare it with the committed manifest.
//                      Needs SUPABASE_ACCESS_TOKEN and PROJECT_REF.
//   --self-test        Unit tests for the parser and comparison.
//
// Only function signatures are printed, never bodies.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export const MANIFEST_PATH = 'supabase/function-manifest.tsv';
const QUERY_PATH = 'scripts/function-manifest.sql';
const LINE = /^((?:public|crm_private)\.[^\t]+\))\t([0-9a-f]{64})$/;

export function parseManifest(text, label) {
  const entries = new Map();
  const lines = text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`${label}: no functions`);
  for (const line of lines) {
    const match = LINE.exec(line);
    if (!match) throw new Error(`${label}: malformed line: ${line.slice(0, 120)}`);
    if (entries.has(match[1])) throw new Error(`${label}: duplicate function ${match[1]}`);
    entries.set(match[1], match[2]);
  }
  return entries;
}

export function compareManifests(expected, actual) {
  const missing = [...expected.keys()].filter((key) => !actual.has(key)).sort();
  const unexpected = [...actual.keys()].filter((key) => !expected.has(key)).sort();
  const changed = [...expected.keys()].filter((key) => actual.has(key) && actual.get(key) !== expected.get(key)).sort();
  return { missing, unexpected, changed, ok: missing.length + unexpected.length + changed.length === 0 };
}

export function serialiseManifest(entries) {
  return [...entries.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}\t${entries.get(key)}`)
    .join('\n') + '\n';
}

function report(result, expectedLabel, actualLabel) {
  for (const key of result.missing) console.error(`::error::In ${expectedLabel} but absent from ${actualLabel}: ${key}`);
  for (const key of result.unexpected) console.error(`::error::In ${actualLabel} but absent from ${expectedLabel}: ${key}`);
  for (const key of result.changed) console.error(`::error::Definition differs between ${expectedLabel} and ${actualLabel}: ${key}`);
}

async function readProduction() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.PROJECT_REF;
  if (!token || !/^[a-z0-9]{20}$/.test(ref || '')) throw new Error('SUPABASE_ACCESS_TOKEN and PROJECT_REF are required');
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: readFileSync(QUERY_PATH, 'utf8'), read_only: true }),
    redirect: 'error',
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Production read failed with HTTP ${response.status}`);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('Production read returned an unexpected shape');
  return rows.map((row) => {
    const values = Object.values(row);
    if (values.length !== 1 || typeof values[0] !== 'string') throw new Error('Production read returned an unexpected row');
    return values[0];
  }).join('\n');
}

function selfTest() {
  const h = (c) => c.repeat(64);
  const base = `public.a()\t${h('a')}\ncrm_private.b(p uuid)\t${h('b')}\n`;
  const expected = parseManifest(base, 'base');
  assert.equal(expected.size, 2);
  assert.ok(compareManifests(expected, parseManifest(base, 'same')).ok);
  const changed = compareManifests(expected, parseManifest(base.replace(h('b'), h('c')), 'changed'));
  assert.deepEqual(changed.changed, ['crm_private.b(p uuid)']);
  const removed = compareManifests(expected, parseManifest(`public.a()\t${h('a')}\n`, 'removed'));
  assert.deepEqual(removed.missing, ['crm_private.b(p uuid)']);
  const added = compareManifests(expected, parseManifest(`${base}public.z()\t${h('d')}\n`, 'added'));
  assert.deepEqual(added.unexpected, ['public.z()']);
  assert.throws(() => parseManifest('', 'empty'));
  assert.throws(() => parseManifest(`public.a()\tnothex\n`, 'bad hash'));
  assert.throws(() => parseManifest(`auth.a()\t${h('a')}\n`, 'other schema'));
  assert.throws(() => parseManifest(`${base}public.a()\t${h('a')}\n`, 'duplicate'));
  assert.equal(serialiseManifest(expected), `crm_private.b(p uuid)\t${h('b')}\npublic.a()\t${h('a')}\n`);
  const committed = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'), MANIFEST_PATH);
  assert.equal(serialiseManifest(committed), readFileSync(MANIFEST_PATH, 'utf8'), 'committed manifest must be sorted and normalised');
  console.log(`Function manifest self-test passed (${committed.size} committed functions).`);
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === '--self-test') return selfTest();
  if (mode === '--write') {
    if (!file) throw new Error('--write needs a manifest file');
    writeFileSync(MANIFEST_PATH, serialiseManifest(parseManifest(readFileSync(file, 'utf8'), file)));
    console.log(`Wrote ${MANIFEST_PATH}`);
    return;
  }
  // An intermediate release may compare against its clean local migration
  // snapshot, generated before connecting to production. Never skip comparison.
  const expectedPath = mode === '--production' && file ? file : MANIFEST_PATH;
  const expected = parseManifest(readFileSync(expectedPath, 'utf8'), expectedPath);
  let actual;
  let actualLabel;
  if (mode === '--compare') {
    if (!file) throw new Error('--compare needs a manifest file');
    actual = parseManifest(readFileSync(file, 'utf8'), file);
    actualLabel = 'the database built from migrations';
  } else if (mode === '--production') {
    actual = parseManifest(await readProduction(), 'production');
    actualLabel = 'production';
  } else {
    throw new Error('Expected --compare <file>, --write <file>, --production or --self-test');
  }
  const result = compareManifests(expected, actual);
  if (!result.ok) {
    report(result, expectedPath, actualLabel);
    if (mode === '--compare') {
      // Only signatures and hashes, never SQL bodies. Preserve the failing gate.
      for (const key of [...result.unexpected, ...result.changed].sort()) {
        console.error(`Generated manifest entry: ${key}\t${actual.get(key)}`);
      }
      console.error('If a migration in this change intentionally alters these functions, regenerate the manifest:');
      console.error(`  psql "$DB_URL" -X -A -t -v ON_ERROR_STOP=1 -f ${QUERY_PATH} > /tmp/functions.tsv && node scripts/check-function-manifest.mjs --write /tmp/functions.tsv`);
    }
    process.exit(1);
  }
  console.log(`Function definitions match ${expectedPath} in ${actualLabel}: ${expected.size} functions.`);
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});
