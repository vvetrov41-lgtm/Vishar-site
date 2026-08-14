#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  __testing,
  classifyBookingHostPath,
  handleBookingHostRequest,
  rewriteBookingHostHtml,
} from '../workers/booking-host.js';

assert.equal(__testing.HOST, 'booking.vishartattoo.com');
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
</head><body><div id="site-nav"></div><div id="site-footer"></div><script src="/components.js" defer></script></body></html>`;
const rewritten = rewriteBookingHostHtml(sampleBooking, '/booking/');
assert.match(rewritten, /noindex, follow/);
assert.match(rewritten, /https:\/\/booking\.vishartattoo\.com\//);
assert.match(rewritten, /https:\/\/tattooai\.vvetrov41\.workers\.dev\//);
assert.doesNotMatch(rewritten, /components\.js/);
assert.match(rewritten, /Vladimir Vishar/);

const calls = [];
const fetchImpl = async (url) => {
  calls.push(url);
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
assert.match(await rootResponse.text(), /tattooai\.vvetrov41\.workers\.dev/);
assert.deepEqual(calls, ['https://vishartattoo.com/booking/']);

const assetResponse = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/assets/css/tailwind.css'),
  { fetchImpl }
);
assert.equal(assetResponse.status, 200);
assert.equal(await assetResponse.text(), 'body{background:#000}');

const blocked = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/portfolio/') ,
  { fetchImpl }
);
assert.equal(blocked.status, 404);
assert.equal(calls.length, 2);

const wrongHost = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com.evil.example/'),
  { fetchImpl }
);
assert.equal(wrongHost.status, 404);

const post = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/', { method: 'POST' }),
  { fetchImpl }
);
assert.equal(post.status, 405);

const redirect = await handleBookingHostRequest(
  new Request('https://booking.vishartattoo.com/booking/?utm_campaign=x'),
  { fetchImpl }
);
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.get('location'), 'https://booking.vishartattoo.com/?utm_campaign=x');

console.log('booking host Worker tests passed');
