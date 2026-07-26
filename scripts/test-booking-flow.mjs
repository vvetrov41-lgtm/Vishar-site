#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(rootDir, 'workers/tattooai.js');
const workerSource = (await readFile(workerPath, 'utf8')).replace(
  /^export default/,
  'globalThis.__tattooAiWorker ='
);
const context = {
  Array,
  Blob,
  Date,
  FormData,
  JSON,
  Number,
  Object,
  Request,
  Response,
  Set,
  String,
  Uint8Array,
  atob,
  console,
};
new Script(workerSource, { filename: 'workers/tattooai.js' }).runInNewContext(context);

const env = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: 'test-chat',
};

function validEnquiry(overrides = {}) {
  return {
    type: 'tattoo-enquiry',
    name: 'Test Client',
    email: 'client@example.com',
    phone: '',
    instagram: '',
    preferredReply: 'Email',
    travellingFrom: 'London',
    projectType: 'Colour realism',
    placement: 'Outer forearm',
    size: '20 cm',
    coverUp: 'No',
    timing: 'Flexible',
    idea: 'A realistic raven with natural lighting.',
    website: '',
    startedAt: Date.now() - 2_000,
    images: [{ name: 'reference.jpg', type: 'image/jpeg', data: btoa('reference') }],
    source: '/booking/',
    ...overrides,
  };
}

function enquiryRequest(body) {
  return new Request('https://tattooai.vvetrov41.workers.dev/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://vishartattoo.com',
    },
    body: JSON.stringify(body),
  });
}

async function send(body, fetchImpl) {
  context.fetch = fetchImpl;
  const response = await context.__tattooAiWorker.fetch(enquiryRequest(body), env);
  return { response, payload: await response.json() };
}

{
  const { response, payload } = await send(
    validEnquiry({ preferredReply: 'WhatsApp', phone: '' }),
    async () => {
      throw new Error('Telegram must not be called for an invalid WhatsApp enquiry.');
    }
  );
  assert.equal(response.status, 400);
  assert.match(payload.error, /WhatsApp number is required/);
}

{
  const { response, payload } = await send(
    validEnquiry({ preferredReply: 'Instagram', instagram: '' }),
    async () => {
      throw new Error('Telegram must not be called for an invalid Instagram enquiry.');
    }
  );
  assert.equal(response.status, 400);
  assert.match(payload.error, /Instagram username is required/);
}

{
  let documentUploads = 0;
  const { response, payload } = await send(
    validEnquiry({
      images: [
        { name: 'reference-1.jpg', type: 'image/jpeg', data: btoa('reference-1') },
        { name: 'reference-2.jpg', type: 'image/jpeg', data: btoa('reference-2') },
      ],
    }),
    async (url) => {
      if (String(url).endsWith('/sendMessage')) return new Response('{}', { status: 200 });
      if (String(url).endsWith('/sendDocument')) {
        documentUploads += 1;
        return new Response('{}', { status: documentUploads === 1 ? 502 : 200 });
      }
      throw new Error('Unexpected Telegram endpoint: ' + url);
    }
  );
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.imageWarning, true);
  assert.equal(payload.failedImageCount, 1);
  assert.equal(documentUploads, 2);
}

{
  const { response, payload } = await send(
    validEnquiry(),
    async () => new Response('{}', { status: 200 })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, imageWarning: false, failedImageCount: 0 });
}

console.log('Booking flow tests passed: contact validation and reference delivery reporting.');
