const pageUrl = 'https://www.kristinavishar.com/booking/';
const scriptUrl = 'https://www.kristinavishar.com/site.js';
const apiUrl = 'https://www.kristinavishar.com/api/booking';

const requiredControls = [
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
const publicJs = await readText(scriptUrl, 'site.js');

if (!/<form\b/i.test(html)) throw new Error('Kristina booking page no longer contains a form');
if (!/<script\b[^>]*src=["']\/site\.js["']/i.test(html)) {
  throw new Error('Kristina booking page no longer loads /site.js');
}

const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .filter(Boolean);
const controlSet = new Set(controls);
const missingControls = requiredControls.filter((name) => !controlSet.has(name));
if (missingControls.length > 0) {
  throw new Error(`Kristina booking form is missing required controls: ${missingControls.join(', ')}`);
}

const publicJsChecks = [
  [/addEventListener\s*\(\s*["']submit["']/, 'submit handler'],
  [/new\s+FormData\s*\(/, 'FormData submission'],
  [/fetch\s*\(\s*["']\/api\/booking["']/, 'same-origin /api/booking fetch'],
  [/response\.ok|res\.ok/, 'HTTP success check'],
];
for (const [pattern, label] of publicJsChecks) {
  if (!pattern.test(publicJs)) throw new Error(`Kristina public JavaScript is missing ${label}`);
}

const form = new FormData();
form.set('name', 'Production route probe');
form.set('email', 'route-probe@example.invalid');
form.set('phone', '');
form.set('instagram', '');
form.set('preferredReply', 'Email');
form.set('travellingFrom', 'London');
form.set('projectType', 'Custom colour');
form.set('placement', 'Forearm');
form.set('size', '10 cm');
form.set('coverUp', 'No');
form.set('timing', 'Flexible');
form.set('discoverySource', 'google');
form.set('discoverySourceDetail', '');
form.set('idea', 'Production route contract probe');
form.set('website', '');
form.set('consent', 'yes');
const pngSignatureWithPadding = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
form.set(
  'references',
  new Blob([pngSignatureWithPadding], { type: 'image/jpeg' }),
  'route-probe.jpeg',
);

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

if (response.status !== 400 || body?.code !== 'file_content_mismatch') {
  throw new Error(
    `Kristina booking endpoint contract changed: HTTP ${response.status}, code ${String(body?.code ?? 'missing')}`,
  );
}

console.log(
  'Kristina live booking contract is healthy: page, site.js, same-origin adapter and JPEG content validation all reached without persistence.',
);
