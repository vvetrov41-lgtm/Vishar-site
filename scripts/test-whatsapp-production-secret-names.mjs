#!/usr/bin/env node

import assert from 'node:assert/strict';
import { validateWhatsAppProductionSecretNames } from './validate-whatsapp-production-secret-names.mjs';

const secret = (name) => ({ name, type: 'secret_text' });
const artists = [
  secret('ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION'),
  secret('ARTIST_WHATSAPP_KRISTINA_HPRODUCTION'),
  secret('ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION'),
];

assert.deepEqual(
  validateWhatsAppProductionSecretNames('drain', [secret('SUPABASE_SECRET_KEY'), ...artists]),
  { artistBindingCount: 3 },
);
assert.deepEqual(
  validateWhatsAppProductionSecretNames('webhook', [
    secret('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    ...artists,
    secret('SUPABASE_SECRET_KEY'),
  ]),
  { artistBindingCount: 3 },
);

for (const [label, kind, values, message] of [
  ['missing fixed secret', 'drain', artists, /SUPABASE_SECRET_KEY/],
  ['missing artist secret', 'webhook', [secret('SUPABASE_SECRET_KEY'), secret('WHATSAPP_WEBHOOK_VERIFY_TOKEN')], /no well-formed artist/],
  ['staging route', 'drain', [secret('SUPABASE_SECRET_KEY'), secret('ARTIST_WHATSAPP_FUTURE_HSTAGING')], /unexpected secret names/],
  ['malformed route', 'drain', [secret('SUPABASE_SECRET_KEY'), secret('ARTIST_WHATSAPP_FUTURE-PRODUCTION')], /unexpected secret names/],
  ['global provider secret', 'drain', [secret('SUPABASE_SECRET_KEY'), artists[0], secret('WHATSAPP_ACCESS_TOKEN')], /unexpected secret names/],
  ['duplicate name', 'drain', [secret('SUPABASE_SECRET_KEY'), artists[0], artists[0]], /duplicate names/],
]) {
  assert.throws(() => validateWhatsAppProductionSecretNames(kind, values), message, label);
}

console.log('WhatsApp production secret-name tests passed: future artists are accepted and ambiguous inventories fail closed.');

