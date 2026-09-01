#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const ARTIST_BINDING = /^ARTIST_WHATSAPP_[A-Z0-9]+(?:_H[A-Z0-9]+)*_HPRODUCTION$/;
const FIXED_BY_WORKER = Object.freeze({
  drain: Object.freeze(['SUPABASE_SECRET_KEY']),
  webhook: Object.freeze(['SUPABASE_SECRET_KEY', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN']),
});

export function validateWhatsAppProductionSecretNames(kind, values) {
  const fixed = FIXED_BY_WORKER[kind];
  if (!fixed) throw new Error(`Unknown WhatsApp production Worker kind: ${kind}`);
  if (!Array.isArray(values)) throw new Error('Worker secret inventory must be an array');

  const names = values.map((entry) => entry?.name);
  if (names.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error('Worker secret inventory contains a malformed entry');
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Worker secret inventory contains duplicate names');
  }

  for (const required of fixed) {
    if (!names.includes(required)) throw new Error(`Required production Worker secret is missing: ${required}`);
  }

  const fixedSet = new Set(fixed);
  const artistBindings = names.filter((name) => ARTIST_BINDING.test(name)).sort();
  const unexpected = names.filter((name) => !fixedSet.has(name) && !ARTIST_BINDING.test(name)).sort();
  if (unexpected.length > 0) {
    throw new Error(`Production Worker has unexpected secret names: ${unexpected.join(', ')}`);
  }
  if (artistBindings.length === 0) {
    throw new Error('Production Worker has no well-formed artist-scoped WhatsApp secret');
  }
  if (names.length !== fixed.length + artistBindings.length) {
    throw new Error('Production Worker secret-name inventory is ambiguous');
  }

  return Object.freeze({ artistBindingCount: artistBindings.length });
}

function main() {
  const kind = process.argv[2];
  let values;
  try {
    values = JSON.parse(process.env.SECRET_LIST || '[]');
  } catch {
    throw new Error('Worker secret inventory is not valid JSON');
  }
  const result = validateWhatsAppProductionSecretNames(kind, values);
  console.log(`Validated ${result.artistBindingCount} artist-scoped WhatsApp secret name(s) for ${kind}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

