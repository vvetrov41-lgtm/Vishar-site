#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const booking = await fs.readFile(path.join(rootDir, 'booking', 'index.html'), 'utf8');
const privacy = await fs.readFile(path.join(rootDir, 'privacy', 'index.html'), 'utf8');
const headers = await fs.readFile(path.join(rootDir, '_headers'), 'utf8');

assert.match(booking, /pixelId: 'XkQY5Xq3FbxJvAx2qDD9my'/);
assert.match(booking, /const OPENAI_ADS_CONSENT_KEY = 'vishar-openai-ads-consent'/);
assert.match(booking, /storedConsent\(OPENAI_ADS_CONSENT_KEY\) !== 'granted'/);
assert.match(booking, /cookieValue\('__oppref'\)/);
assert.match(booking, /window\.location\.origin \+ window\.location\.pathname/);

for (const field of [
  'openaiAdsMeasurementConsent',
  'openaiAdsSourceUrl',
  'openaiAdsOppref',
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
assert.ok(!booking.includes("payload.append('openaiAdsObref'"),
  'PR #909 intentionally removed the unused obref forwarding path');

assert.match(privacy, /server-to-server through the OpenAI Ads Conversions API/);
assert.match(privacy, /<code>__obref<\/code>/);
assert.match(privacy, /OpenAI Ads measurement does not manually transmit your contact details/);
assert.match(privacy, /Meta's optional, separately consented Conversions API may use SHA-256-hashed email and phone number/);

// The pixel is loaded by booking/index.html and disclosed in the privacy
// notice; the site-wide CSP must let it load and report, or it silently
// never measures anything.
const csp = headers.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1] ?? '';
const directive = (name) => (csp.match(new RegExp(`(?:^|;)\\s*${name} ([^;]+)`))?.[1] ?? '').split(/\s+/);
assert.ok(booking.includes("'https://bzrcdn.openai.com/sdk/oaiq.min.js'"));
// Consent gate: the SDK script is only inserted by the loader, and the loader
// only runs for a stored or newly given grant.
const head = booking.slice(0, booking.indexOf('</head>'));
assert.equal((head.match(/insertBefore\(js, first\)/g) || []).length, 1, 'one SDK insertion point');
const loaderStart = head.indexOf('w.visharLoadOpenAiAdsPixel = function');
const insertAt = head.indexOf('insertBefore(js, first)');
assert.ok(loaderStart > 0 && insertAt > loaderStart, 'the SDK is inserted only inside the consent loader');
assert.match(head, /if \(consent === 'granted'\) \{\s*w\.oaiq\('consent', true\);\s*w\.visharLoadOpenAiAdsPixel\(\);/);
assert.match(booking, /if \(value === 'granted' && typeof window\.visharLoadOpenAiAdsPixel === 'function'\) \{\s*window\.visharLoadOpenAiAdsPixel\(\);/);
assert.ok(directive('script-src').includes('https://bzrcdn.openai.com'), 'CSP script-src must allow the OpenAI Ads pixel SDK');
assert.ok(directive('connect-src').includes('https://bzr.openai.com'), 'CSP connect-src must allow the OpenAI Ads pixel event endpoint');
assert.ok(directive('connect-src').includes('https://bzrcdn.openai.com'), 'CSP connect-src must allow the OpenAI Ads pixel configuration fetch');

// Meta's server handoff was missing even though the browser Pixel fired Lead.
assert.match(booking, /const META_ADS_CONSENT_VERSION = '2026-10-08-capi'/);
assert.match(booking, /key === META_ADS_CONSENT_KEY && value === 'granted'/);
assert.match(booking, /localStorage.getItem\(META_ADS_CONSENT_VERSION_KEY\) !== META_ADS_CONSENT_VERSION/);
assert.match(booking, /function metaAdsServerContext\(\)/);
assert.match(booking, /storedConsent\(META_ADS_CONSENT_KEY\) !== 'granted'/);
for (const field of ['metaAdsMeasurementConsent', 'metaAdsSourceUrl', 'metaAdsFbp', 'metaAdsFbc']) {
  assert.ok(booking.includes(`payload.append('${field}'`), `Meta ${field} must reach the intake Worker`);
}
const metaContextStart = booking.indexOf('const metaContext = metaAdsServerContext();');
const metaPixelStart = booking.indexOf('trackMetaLead(enquiryKey);');
assert.ok(metaContextStart > 0 && metaContextStart < fetchStart);
assert.ok(fetchStart > 0 && fetchStart < metaPixelStart);
assert.match(booking, /window\.fbq\('track', 'Lead', \{\}, \{ eventID: eventId \}\)/);
assert.match(privacy, /Meta Conversions API/);
assert.match(privacy, /SHA-256-hashed email and phone number/);
assert.match(privacy, /Previously saved Pixel-only consent does not authorize this expanded processing/);
console.log('OpenAI and Meta Ads browser-to-server context checks passed.');
