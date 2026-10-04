#!/usr/bin/env node
// Regression: an image the CRM accepts must reach the vision model.
//
// An earlier Worker capped vision payloads near 1.5 MB while the CRM accepts
// reference images up to 4 MiB, so every larger photo failed analysis
// deterministically. This pins one ceiling across the upload contract (table
// constraint, upload RPC, storage bucket, local config) and the Worker path
// (download, router), and pushes a 3.9 MB image through both.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MAX_IMAGE_BYTES } from '../workers/lib/ai/tasks.js';
import { normalizeRequest } from '../workers/lib/ai/router.js';
import { resolveTask } from '../workers/lib/ai/tasks.js';
import { loadPrivateImage } from '../workers/lib/crm-agent.js';

const FOUR_MIB = 4 * 1024 * 1024;
let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; } catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}

const migrations = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n');

await test('the Worker ceiling is the CRM upload ceiling', () => {
  assert.equal(MAX_IMAGE_BYTES, FOUR_MIB);
  assert.match(migrations, /enquiry_files_byte_size_max check \(byte_size <= 4 \* 1024 \* 1024\)/);
  assert.match(migrations, /p_byte_size > 4 \* 1024 \* 1024/);
  assert.match(migrations, /'crm-files',\s*'crm-files',\s*false,\s*4 \* 1024 \* 1024/);
  assert.match(readFileSync('supabase/config.toml', 'utf8'), /file_size_limit = "4MiB"/);
});

const bytes = (n) => new Uint8Array(n).fill(0x41);
const storage = (n) => ({ async createSignedUrl() { return 'https://storage.example/signed'; } });
const fetchBytes = (n) => async () => new Response(bytes(n));

await test('a 3.9 MB image is downloaded and reaches the router intact', async () => {
  const size = 3_900_000;
  const image = await loadPrivateImage({}, 'clients/x/enquiries/y/references/z.jpg', {
    supabase: {}, storage: storage(size), fetchImpl: fetchBytes(size),
  });
  assert.ok(image.dataBase64, `rejected: ${image.error}`);
  const plan = resolveTask({}, 'vision_reference_extraction', new Set(['qwen', 'workers_ai']));
  const normalized = normalizeRequest(plan, {
    system: 'Describe.', input: 'Describe this image.', images: [{ mimeType: 'image/jpeg', dataBase64: image.dataBase64 }],
  });
  assert.ok(normalized.request, `router refused: ${normalized.error}`);
  assert.equal(normalized.request.images[0].dataBase64.length, image.dataBase64.length);
});

await test('exactly 4 MiB is accepted and one byte more is refused', async () => {
  const at = await loadPrivateImage({}, 'p.jpg', { supabase: {}, storage: storage(FOUR_MIB), fetchImpl: fetchBytes(FOUR_MIB) });
  assert.ok(at.dataBase64);
  const over = await loadPrivateImage({}, 'p.jpg', { supabase: {}, storage: storage(FOUR_MIB + 1), fetchImpl: fetchBytes(FOUR_MIB + 1) });
  assert.equal(over.error, 'image_unsupported');
});

console.log(`vision upload cap: ${passes} passed`);
