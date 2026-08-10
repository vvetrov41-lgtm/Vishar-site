#!/usr/bin/env node

import assert from 'node:assert/strict';
import previewWorker from '../workers/preview.js';

const VLADIMIR_ORIGIN = 'https://vishar-booking-staging.pages.dev';
const KRISTINA_ORIGIN = 'https://agent-kristina-booking-crm-setup-kisa.vvetrov41.workers.dev';
const INTAKE_URL = 'https://intake-staging.vishartattoo.com/__vishar-staging-intake-2026';

const env = {
  ALLOWED_ORIGINS: `${VLADIMIR_ORIGIN},${KRISTINA_ORIGIN}`,
  // These intentionally simulate retained stale scalar bindings. The preview
  // wrapper must select the trusted source from the exact observed Origin.
  BOOKING_SOURCE_KEY: 'vladimir-staging',
  BOOKING_FORM_VERSION: 'booking-v1',
};

for (const origin of [VLADIMIR_ORIGIN, KRISTINA_ORIGIN]) {
  const request = new Request(INTAKE_URL, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
    },
  });
  const response = await previewWorker.fetch(request, env, {});
  assert.equal(response.status, 204, `${origin} preflight status`);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin, `${origin} ACAO`);
  assert.equal(response.headers.get('Vary'), 'Origin', `${origin} Vary`);
}

for (const origin of [
  'https://evil.example',
  'https://agent-kristina-booking-crm-setup-kisa.vvetrov41.workers.dev.evil.example',
]) {
  const request = new Request(INTAKE_URL, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
    },
  });
  const response = await previewWorker.fetch(request, env, {});
  assert.equal(response.status, 403, `${origin} rejection status`);
  const body = await response.json();
  assert.equal(body.code, 'origin_not_allowed');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
}

console.log('preview Origin boundary tests passed');
