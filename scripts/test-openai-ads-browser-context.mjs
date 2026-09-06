#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const booking = await fs.readFile(path.join(rootDir, 'booking', 'index.html'), 'utf8');
const privacy = await fs.readFile(path.join(rootDir, 'privacy', 'index.html'), 'utf8');

assert.match(booking, /pixelId: 'XkQY5Xq3FbxJvAx2qDD9my'/);
assert.match(booking, /const OPENAI_ADS_CONSENT_KEY = 'vishar-openai-ads-consent'/);
assert.match(booking, /storedConsent\(OPENAI_ADS_CONSENT_KEY\) !== 'granted'/);
assert.match(booking, /cookieValue\('__oppref'\)/);
assert.match(booking, /cookieValue\('__obref'\)/);
assert.match(booking, /window\.location\.origin \+ window\.location\.pathname/);

for (const field of [
  'openaiAdsMeasurementConsent',
  'openaiAdsSourceUrl',
  'openaiAdsOppref',
  'openaiAdsObref',
]) {
  assert.ok(booking.includes(`payload.append('${field}'`), `${field} must be handed to the Worker`);
}

const contextStart = booking.indexOf('const adsContext = openAiAdsServerContext();');
const fetchStart = booking.indexOf('const response = await fetch(endpoint');
const pixelStart = booking.indexOf('trackOpenAiLead(enquiryKey);');
assert.ok(contextStart > 0 && contextStart < fetchStart, 'server context must be attached before the Worker request');
assert.ok(fetchStart > 0 && fetchStart < pixelStart, 'browser conversion must remain after Worker-confirmed success');

assert.match(
  booking,
  /'measure',\s*'lead_created',[\s\S]*?\{ event_id: eventId, opt_out: true \}/
);
assert.ok(!booking.includes("payload.append('openaiAdsEmail'"));
assert.ok(!booking.includes("payload.append('openaiAdsPhone'"));
assert.ok(!booking.includes("payload.append('openaiAdsName'"));

assert.match(privacy, /server-to-server through the OpenAI Ads Conversions API/);
assert.match(privacy, /<code>__obref<\/code>/);
assert.match(privacy, /does not manually send your name, email, phone number, Instagram username, reference images or tattoo description/);

console.log('OpenAI Ads browser context checks passed.');
