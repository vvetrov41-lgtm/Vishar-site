// Live, non-persistent check of Vladimir's public booking contract.
//
// Reads https://vishartattoo.com/booking/ (expects the enquiry-v2 flag) and
// posts a complete enquiry-v2 payload with one non-image attachment to the
// TattooAI intake with Vladimir's Origin. TattooAI resolves the source,
// validates every field and the privacy version, then refuses the file before
// anything persists. Companion to probe-kristina-live-booking-contract.mjs.

const UA = 'Vishar-CRM-production-contract-probe/1.0';
const page = await fetch('https://vishartattoo.com/booking/', { headers: { 'User-Agent': UA } });
const html = await page.text();
const flag = /<meta name="vishar-enquiry-form" content="([^"]+)"/.exec(html)?.[1];
if (page.status !== 200) throw new Error(`Vladimir booking page returned HTTP ${page.status}`);
if (flag !== 'v2') throw new Error(`Vladimir booking page flag is ${flag ?? 'missing'}, expected v2`);

const form = new FormData();
const fields = {
  formSchema: 'enquiry-v2',
  projectDetails: JSON.stringify({ areas: [{ region: 'arm', placements: ['forearm'], work: ['new'] }], styles: ['black_grey'], sizeNotes: '15 cm' }),
  name: 'Production route probe',
  email: 'route-probe@example.invalid',
  phone: '',
  preferredReply: 'Email',
  timing: 'Flexible',
  idea: 'Production route contract probe',
  discoverySource: 'google',
  discoverySourceDetail: '',
  website: '',
  privacyAcknowledged: 'true',
  privacyNoticeVersion: '2026-09-09',
  source: '/booking/',
  idempotencyKey: crypto.randomUUID(),
};
for (const [key, value] of Object.entries(fields)) form.set(key, value);
form.set('designReferences', new Blob(['not an image'], { type: 'image/png' }), 'not-an-image.txt');

const response = await fetch('https://api.vishartattoo.com/', {
  method: 'POST',
  headers: { Origin: 'https://vishartattoo.com', Accept: 'application/json', 'User-Agent': UA },
  body: form,
});
let body;
try { body = await response.json(); } catch { throw new Error(`Vladimir intake returned non-JSON HTTP ${response.status}`); }
if (response.status !== 400 || body?.code !== 'invalid_file_extension') {
  throw new Error(`Vladimir booking contract changed: HTTP ${response.status}, code ${String(body?.code ?? 'missing')}`);
}
console.log('Vladimir live booking contract (enquiry-v2) is healthy: page flag, source, fields and privacy version reached TattooAI validation without persistence.');
