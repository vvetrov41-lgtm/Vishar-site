const pageUrl = 'https://www.kristinavishar.com/booking/';
const scriptUrl = 'https://www.kristinavishar.com/site.js';
const apiUrl = 'https://www.kristinavishar.com/api/booking';

// Kristina's page moves from the legacy single-step form to an enquiry-v2
// form. The probe follows whichever contract the live page declares, so a
// TattooAI release is never blocked by the order in which the two repositories
// ship. The v2 page marks its form with data-form-schema="enquiry-v2".
const LEGACY_CONTROLS = [
  'name',
  'email',
  'preferredReply',
  'travellingFrom',
  'projectType',
  'placement',
  'size',
  'coverUp',
  'timing',
  'idea',
  'consent',
  'references',
];
const V2_CONTROLS = [
  'name',
  'email',
  'phone',
  'preferredReply',
  'region',
  'placement',
  'work',
  'style',
  'sizeNotes',
  'idea',
  'consent',
  'designReferences',
  'existingTattooPhotos',
];

const readText = async (url, label) => {
  const response = await fetch(url, {
    headers: {
      Accept: label === 'page' ? 'text/html' : 'application/javascript,text/javascript,*/*',
      'User-Agent': 'Vishar-CRM-production-contract-probe/1.0',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return response.text();
};

const html = await readText(pageUrl, 'page');
const v2 = /<form\b[^>]*\bdata-form-schema=["']enquiry-v2["']/i.test(html);

if (!/<form\b/i.test(html)) throw new Error('Kristina booking page no longer contains a form');

// The submit code may live in /site.js or in a versioned same-origin booking
// script (for example /booking/enquiry.js?v=3); check every local script.
const scriptPaths = [...html.matchAll(/<script\b[^>]*\bsrc=["'](\/[^"'#]+)["']/gi)].map((match) => match[1]);
if (!scriptPaths.some((path) => /^\/site\.js(?:\?|$)/.test(path))) {
  throw new Error('Kristina booking page no longer loads /site.js');
}
const scripts = await Promise.all(
  scriptPaths.map((path) => readText(new URL(path, scriptUrl).toString(), path)),
);
const publicJs = scripts.join('\n');

const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .filter(Boolean);
const controlSet = new Set(controls);
const missingControls = (v2 ? V2_CONTROLS : LEGACY_CONTROLS).filter((name) => !controlSet.has(name));
if (missingControls.length > 0) {
  throw new Error(`Kristina booking form is missing required controls: ${missingControls.join(', ')}`);
}

const publicJsChecks = [
  [/addEventListener\s*\(\s*["']submit["']/, 'submit handler'],
  [/new\s+FormData\s*\(/, 'FormData submission'],
  [/["']\/api\/booking["']/, 'same-origin /api/booking endpoint'],
  [/response\.ok|res\.ok|\.status\s*>=\s*200/, 'HTTP success check'],
  ...(v2 ? [
    [/["']enquiry-v2["']/, 'enquiry-v2 form schema'],
    [/projectDetails/, 'structured project details'],
  ] : []),
];
for (const [pattern, label] of publicJsChecks) {
  if (!pattern.test(publicJs)) throw new Error(`Kristina public JavaScript is missing ${label}`);
}

// A complete, valid enquiry except for one non-image attachment: TattooAI
// resolves the source, validates every field and the privacy notice version
// sent by Kristina's Worker, then refuses the file before anything persists.
const form = new FormData();
form.set('name', 'Production route probe');
form.set('email', 'route-probe@example.invalid');
form.set('phone', '');
form.set('preferredReply', 'Email');
form.set('timing', 'Flexible');
form.set('discoverySource', 'google');
form.set('discoverySourceDetail', '');
form.set('idea', 'Production route contract probe');
form.set('website', '');
form.set('consent', 'yes');
if (v2) {
  form.set('formSchema', 'enquiry-v2');
  form.set('projectDetails', JSON.stringify({
    areas: [{ region: 'arm', placements: ['forearm'], work: ['new'] }],
    styles: ['floral'],
    sizeNotes: '10-15 cm',
  }));
  form.set('designReferences', new Blob(['not an image'], { type: 'image/png' }), 'not-an-image.txt');
} else {
  form.set('instagram', '');
  form.set('travellingFrom', 'London');
  form.set('projectType', 'Custom colour');
  form.set('placement', 'Forearm');
  form.set('size', '10 cm');
  form.set('coverUp', 'No');
  form.set('references', new Blob(['not an image'], { type: 'image/png' }), 'not-an-image.txt');
}

const response = await fetch(apiUrl, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    Origin: 'https://www.kristinavishar.com',
    'User-Agent': 'Vishar-CRM-production-contract-probe/1.0',
  },
  body: form,
});

let body;
try {
  body = await response.json();
} catch {
  throw new Error(`Kristina booking endpoint returned non-JSON HTTP ${response.status}`);
}

if (response.status !== 400 || body?.code !== 'invalid_file_extension') {
  throw new Error(
    `Kristina booking endpoint contract changed: HTTP ${response.status}, code ${String(body?.code ?? 'missing')}`,
  );
}

console.log(
  `Kristina live booking contract (${v2 ? 'enquiry-v2' : 'legacy'}) is healthy: page, scripts, same-origin adapter and TattooAI validation all reached without persistence.`,
);
