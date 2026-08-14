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
assert.deepEqual(classifyBookingHostPath('/'), { type: 'html', upstreamPath: '/booking/' });
assert.deepEqual(classifyBookingHostPath('/privacy/'), { type: 'html', upstreamPath: '/privacy/' });
assert.deepEqual(classifyBookingHostPath('/booking/'), { type: 'redirect', location: '/' });
assert.deepEqual(classifyBookingHostPath('/assets/css/tailwind.css'), {
  type: 'asset',
  upstreamPath: '/assets/css/tailwind.css',
});
assert.equal(classifyBookingHostPath('/portfolio/'), null);
assert.equal(classifyBookingHostPath('/assets/portfolio/tattoo.jpg'), null);
assert.equal(classifyBookingHostPath('/assets/vendor/fonts/../secret'), null);

const sampleBooking = `<!doctype html><html><head>
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://vishartattoo.com/booking/">
<meta name="vishar-booking-endpoint" content="">
</head><body><div id="site-nav"></div><script>const endpoint = 'https://tattooai.vvetrov41.workers.dev/';</script><div id="site-footer"></div><script src="/components.js" defer></script></body></html>`;
const rewritten = rewriteBookingHostHtml(sampleBooking, '/booking/');
assert.match(rewritten, /noindex, follow/);
assert.match(rewritten, /https:\/\/booking\.vishartattoo\.com\//);
assert.match(rewritten, /https:\/\/booking\.vishartattoo\.com\/api\/enquiry/);
assert.doesNotMatch(rewritten, /https:\/\/tattooai\.vvetrov41\.workers\.dev\//);
assert.doesNotMatch(rewritten, /components\.js/);
assert.match(rewritten, /Vladimir Vishar/);

const upstreamGets = [];
const relayCalls = [];
const fetchImpl = async (url, init = {}) => {
  if (url === __testing.BOOKING_ENDPOINT) {
    relayCalls.push({ url, init, payload: JSON.parse(init.body) });
    return Response.json({ ok: true, imageWarning: false, failedImageCount: 0 });
  }
  upstreamGets.push(url);
  if (url.endsWith('/booking/')) {
    return new Response(sampleBooking, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; connect-src 'self' https://tattooai.vvetrov41.workers.dev",
      },
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

const assetResponse = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/assets/css/tailwind.css'),
  { fetchImpl }
);
assert.equal(assetResponse.status, 200);
assert.equal(await assetResponse.text(), 'body{background:#000}');

const blocked = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/portfolio/'),
  { fetchImpl }
);
assert.equal(blocked.status, 404);
assert.equal(upstreamGets.length, 2);

const wrongHost = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com.evil.example/'),
  { fetchImpl }
);
assert.equal(wrongHost.status, 404);

const postRoot = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/', { method: 'POST' }),
  { fetchImpl }
);
assert.equal(postRoot.status, 405);

const getRelay = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry'),
  { fetchImpl }
);
assert.equal(getRelay.status, 405);

const validJsonPayload = {
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
  idea: 'Test concept',
  website: '',
  startedAt: Date.now() - 2500,
  images: [{ type: 'image/jpeg', data: '/9j/2Q==' }],
  source: 'browser-controlled-source',
  arbitraryProviderField: 'must-not-cross',
};

const jsonRelay = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: {
      Origin: 'https://booking.vishartattoo.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(validJsonPayload),
  }),
  { fetchImpl }
);
assert.equal(jsonRelay.status, 200);
assert.deepEqual(await jsonRelay.json(), { ok: true, imageWarning: false, failedImageCount: 0 });
assert.equal(relayCalls.length, 1);
assert.equal(relayCalls[0].payload.type, 'tattoo-enquiry');
assert.equal(relayCalls[0].payload.source, 'booking.vishartattoo.com');
assert.equal(relayCalls[0].payload.arbitraryProviderField, undefined);
assert.equal(relayCalls[0].init.headers.Origin, 'https://booking.vishartattoo.com');

const spoofedOrigin = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: {
      Origin: 'https://booking.vishartattoo.com.evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(validJsonPayload),
  }),
  { fetchImpl }
);
assert.equal(spoofedOrigin.status, 403);
assert.equal(relayCalls.length, 1);

const genericProxyAttempt = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: {
      Origin: 'https://booking.vishartattoo.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'lead', contact: 'attacker@example.com' }),
  }),
  { fetchImpl }
);
assert.equal(genericProxyAttempt.status, 400);
assert.equal(relayCalls.length, 1);

const honeypot = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: {
      Origin: 'https://booking.vishartattoo.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...validJsonPayload, website: 'bot.example' }),
  }),
  { fetchImpl }
);
assert.equal(honeypot.status, 200);
assert.deepEqual(await honeypot.json(), { ok: true });
assert.equal(relayCalls.length, 1);

const multipart = new FormData();
for (const [key, value] of Object.entries({
  name: 'Multipart Client',
  email: 'multipart@example.com',
  phone: '',
  instagram: '',
  preferredReply: 'Email',
  travellingFrom: 'Leeds',
  projectType: 'Black and grey realism',
  placement: 'Upper arm',
  size: '25 cm',
  coverUp: 'No',
  timing: 'Autumn',
  idea: 'Multipart test concept',
  website: '',
  privacyAcknowledged: 'true',
  privacyNoticeVersion: '2026-07-29',
  elapsedMs: '2500',
})) multipart.append(key, value);
multipart.append(
  'references',
  new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
  'reference.jpg'
);

const multipartRelay = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/api/enquiry', {
    method: 'POST',
    headers: { Origin: 'https://booking.vishartattoo.com' },
    body: multipart,
  }),
  { fetchImpl }
);
assert.equal(multipartRelay.status, 200);
assert.equal(relayCalls.length, 2);
assert.equal(relayCalls[1].payload.name, 'Multipart Client');
assert.equal(relayCalls[1].payload.source, 'booking.vishartattoo.com');
assert.equal(relayCalls[1].payload.images.length, 1);
assert.equal(relayCalls[1].payload.images[0].type, 'image/jpeg');
assert.ok(relayCalls[1].payload.images[0].data.length > 0);
assert.ok(Date.now() - relayCalls[1].payload.startedAt >= 1500);

const redirect = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/booking/?utm_campaign=x'),
  { fetchImpl }
);
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.get('location'), 'https://booking.vishartattoo.com/?utm_campaign=x');

console.log('booking host Worker tests passed');