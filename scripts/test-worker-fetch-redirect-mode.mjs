// Guard against the fetch `error` redirect mode in Cloudflare Worker code.
//
// The Workers runtime refuses that mode and throws a TypeError while the
// Request is constructed, before any subrequest is dispatched:
//
//   Invalid redirect value, must be one of "follow" or "manual" ("error" won't
//   be implemented since it does not make sense at the edge; use "manual" and
//   check the response status code).
//
// Node's fetch accepts it, so every unit test here passes while the same code
// throws in production the first time it runs. That gap took the WhatsApp
// Embedded Signup provisioning endpoint down completely: its first Supabase
// call threw, so no attempt ever reached Meta.
//
// `manual` is the supported equivalent. It never follows a redirect either, so
// an Authorization header is still never replayed to a host we did not choose;
// the 3xx simply arrives as a response and every call site refuses it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __testing } from '../admin/functions/api/whatsapp/embedded-signup/provision.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Directories whose JavaScript is bundled into a Worker or a Pages Function.
// `scripts/` runs under Node, where the `error` mode is legal, so it is absent.
const WORKER_SOURCE_DIRECTORIES = ['workers', 'admin/functions'];
const FORBIDDEN = /redirect\s*:\s*(['"])error\1/;

let passes = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

function* workerSourceFiles(directory) {
  const absolute = path.join(REPOSITORY_ROOT, directory);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* workerSourceFiles(relative);
    else if (/\.(js|mjs|ts)$/.test(entry.name)) yield relative;
  }
}

await test('no Worker source asks for the error redirect mode', () => {
  const offenders = [];
  for (const directory of WORKER_SOURCE_DIRECTORIES) {
    for (const relative of workerSourceFiles(directory)) {
      const source = fs.readFileSync(path.join(REPOSITORY_ROOT, relative), 'utf8');
      source.split('\n').forEach((line, index) => {
        if (FORBIDDEN.test(line)) offenders.push(`${relative}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `The Workers runtime throws on the error redirect mode. Use 'manual' and refuse a 3xx status instead:\n${offenders.join('\n')}`,
  );
});

await test('Worker source does scan for this at all', () => {
  // A path typo would silently pass the guard above, so prove the walker sees
  // the provisioning endpoint the outage was found in.
  const scanned = WORKER_SOURCE_DIRECTORIES.flatMap((d) => [...workerSourceFiles(d)]);
  assert.ok(scanned.length > 10, 'Worker source scan found suspiciously few files');
  assert.ok(scanned.includes(path.join('admin/functions', 'api/whatsapp/embedded-signup/provision.js')));
  assert.ok(scanned.includes(path.join('workers', 'lib/whatsapp.js')));
});

await test('noFollowFetch asks the runtime for the manual redirect mode', async () => {
  let seen = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = init;
    return new Response('{}', { status: 200 });
  };
  try {
    await __testing.noFollowFetch('https://example.invalid/resource', { method: 'GET' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(seen.redirect, 'manual');
  assert.equal(seen.method, 'GET');
});

await test('noFollowFetch refuses a redirect instead of following it', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { location: 'https://attacker.invalid/' },
  });
  try {
    await assert.rejects(
      () => __testing.noFollowFetch('https://example.invalid/resource'),
      (error) => error.message === 'upstream_redirect_rejected' && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('noFollowFetch passes a normal response through', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"id":"ok"}', { status: 200 });
  try {
    const response = await __testing.noFollowFetch('https://example.invalid/resource');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'ok' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`worker fetch redirect mode: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
