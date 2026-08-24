#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  __testing,
  classifyBookingHostPath,
  handleBookingHostRequest,
  rewriteBookingHostHtml,
} from '../workers/booking-host.js';

assert.equal(__testing.HOST, 'booking.vishartattoo.com');
assert.equal(__testing.RELAY_PATH, '/api/enquiry');
assert.equal(__testing.UPSTREAM_ORIGIN, 'https://vishartattoo.com');
assert.deepEqual(classifyBookingHostPath('/'), { type: 'html', upstreamPath: '/booking/' });
assert.deepEqual(classifyBookingHostPath('/privacy/'), { type: 'html', upstreamPath: '/privacy/' });
assert.deepEqual(classifyBookingHostPath('/booking/'), { type: 'redirect', location: '/' });
assert.equal(classifyBookingHostPath('/portfolio/'), null);
assert.equal(classifyBookingHostPath('/assets/vendor/fonts/../secret'), null);

const sampleBooking = `<!doctype html><html><head>
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://vishartattoo.com/booking/">
<meta name="vishar-booking-endpoint" content="">
</head><body><div id="site-nav"></div><script>const endpoint = 'https://tattooai.vvetrov41.workers.dev/';</script><div id="site-footer"></div><script src="/components.js" defer></script></body></html>`;

const rewritten = rewriteBookingHostHtml(sampleBooking, '/booking/');
assert.match(rewritten, /noindex, follow/);
assert.match(rewritten, /https:\/\/booking\.vishartattoo\.com\/api\/enquiry/);
assert.doesNotMatch(rewritten, /https:\/\/tattooai\.vvetrov41\.workers\.dev\//);
assert.doesNotMatch(rewritten, /components\.js/);

const upstreamGets = [];
const relayCalls = [];
const fetchImpl = async (url, init = {}) => {
  if (url === __testing.BOOKING_ENDPOINT) {
    const forwarded = new Request('https://upstream.invalid/', {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      duplex: 'half',
    });
    const form = await forwarded.formData();
    relayCalls.push({ url, init, form });
    return Response.json({
      ok: true,
      reference: 'ENQ-2026-TEST',
      notificationWarning: false,
      imageWarning: false,
      failedNotificationCount: 0,
    });
  }

  upstreamGets.push(url);
  if (url.endsWith('/booking/')) {
    return new Response(sampleBooking, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  if (url.endsWith('/assets/css/tailwind.css')) {
    return new Response('body{background:#000}', {
      status: 200,
      headers: { 'content-type': 'text/css' },
    });
  }
  return new Response('missing', { status: 404 });
};

const rootResponse = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/?utm_source=test'),
  { fetchImpl }
);
assert.equal(rootResponse.status, 200);
assert.equal(rootResponse.headers.get('x-robots-tag'), 'noindex, follow');
const rootHtml = await rootResponse.text();
assert.match(rootHtml, /booking\.vishartattoo\.com\/api\/enquiry/);
assert.doesNotMatch(rootHtml, /tattooai\.vvetrov41\.workers\.dev/);
assert.deepEqual(upstreamGets, ['https://vishartattoo.com/booking/']);

const multipart = new FormData();
for (const [key, value] of Object.entries({
  name: 'Current Contract Client',
  email: 'current-contract@example.com',
  phone: '',
  instagram: '',
  preferredReply: 'Email',
  travellingFrom: 'London',
  projectType: 'Black and grey realism',
  placement: 'Upper arm',
  size: '25 cm',
  coverUp: 'No',
  timing: 'Flexible',
  idea: 'Current multipart relay contract test',
  website: '',
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  privacyAcknowledged: 'true',
  privacyNoticeVersion: '2026-07-29',
  source: '/booking/',
  landingPage: 'https://booking.vishartattoo.com/?utm_source=test',
  referrer: '',
  utmSource: 'test',
  utmMedium: '',
  utmCampaign: '',
  utmContent: '',
  utmTerm: '',
  elapsedMs: '2500',
})) multipart.append(key, value);
multipart.append(
  'references',
  new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
  'reference.jpg'
);

const relayResponse = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: { Origin: 'https://booking.vishartattoo.com' },
    body: multipart,
  }),
  { fetchImpl }
);
assert.equal(relayResponse.status, 200);
assert.deepEqual(await relayResponse.json(), {
  ok: true,
  reference: 'ENQ-2026-TEST',
  notificationWarning: false,
  imageWarning: false,
  failedNotificationCount: 0,
});
assert.equal(relayCalls.length, 1);
assert.equal(relayCalls[0].init.method, 'POST');
assert.equal(relayCalls[0].init.headers.Origin, 'https://vishartattoo.com');
assert.match(relayCalls[0].init.headers['content-type'], /^multipart\/form-data;\s*boundary=/i);
assert.equal(relayCalls[0].form.get('name'), 'Current Contract Client');
assert.equal(relayCalls[0].form.get('idempotencyKey'), '11111111-1111-4111-8111-111111111111');
assert.equal(relayCalls[0].form.get('privacyAcknowledged'), 'true');
assert.equal(relayCalls[0].form.get('landingPage'), 'https://booking.vishartattoo.com/?utm_source=test');
const forwardedFile = relayCalls[0].form.get('references');
assert.equal(forwardedFile.name, 'reference.jpg');
assert.equal(forwardedFile.type, 'image/jpeg');
assert.equal(forwardedFile.size, 4);

const spoofedOriginForm = new FormData();
spoofedOriginForm.append('name', 'Blocked');
const spoofedOrigin = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: { Origin: 'https://booking.vishartattoo.com.evil.example' },
    body: spoofedOriginForm,
  }),
  { fetchImpl }
);
assert.equal(spoofedOrigin.status, 403);
assert.equal(relayCalls.length, 1);

const staleJson = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: {
      Origin: 'https://booking.vishartattoo.com',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'tattoo-enquiry' }),
  }),
  { fetchImpl }
);
assert.equal(staleJson.status, 415);
assert.equal((await staleJson.json()).code, 'multipart_required');
assert.equal(relayCalls.length, 1);

const getRelay = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry'),
  { fetchImpl }
);
assert.equal(getRelay.status, 405);

const blocked = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/portfolio/'),
  { fetchImpl }
);
assert.equal(blocked.status, 404);

const redirect = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/booking/?utm_campaign=x'),
  { fetchImpl }
);
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.get('location'), 'https://booking.vishartattoo.com/?utm_campaign=x');

console.log('booking host Worker tests passed');
