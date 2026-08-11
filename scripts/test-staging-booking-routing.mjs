#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  KRISTINA_STAGING_ORIGIN,
  VLADIMIR_STAGING_ORIGIN,
  __testing,
  readTrustedStagingBookingRoute,
  withTrustedStagingBookingEnv,
} from '../workers/lib/staging-booking-routing.js';

assert.equal(__testing.routeCount, 2);
assert.deepEqual(
  [...__testing.origins].sort(),
  [KRISTINA_STAGING_ORIGIN, VLADIMIR_STAGING_ORIGIN].sort()
);

assert.deepEqual(readTrustedStagingBookingRoute(VLADIMIR_STAGING_ORIGIN), {
  sourceKey: 'vladimir-staging',
  formVersion: 'booking-v1',
});
assert.deepEqual(readTrustedStagingBookingRoute(KRISTINA_STAGING_ORIGIN), {
  sourceKey: 'kristina-website',
  formVersion: 'booking-v1',
});

for (const origin of [
  '',
  null,
  'https://vishar-booking-staging.pages.dev.evil.example',
  'https://agent-kristina-booking-crm-setup-kisa.vvetrov41.workers.dev.evil.example',
  'http://agent-kristina-booking-crm-setup-kisa.vvetrov41.workers.dev',
  'https://f1a337a0-kisa.vvetrov41.workers.dev',
  'https://kisa.vvetrov41.workers.dev',
]) {
  assert.equal(readTrustedStagingBookingRoute(origin), null, String(origin));
  assert.equal(withTrustedStagingBookingEnv({}, origin), null, String(origin));
}

const sentinel = { preserved: true };
const routedKristina = withTrustedStagingBookingEnv({
  ALLOWED_ORIGINS: VLADIMIR_STAGING_ORIGIN,
  BOOKING_SOURCE_KEY: 'stale-source',
  BOOKING_FORM_VERSION: 'stale-version',
  SENTINEL_BINDING: sentinel,
}, KRISTINA_STAGING_ORIGIN);

assert.equal(routedKristina.ALLOWED_ORIGINS, KRISTINA_STAGING_ORIGIN);
assert.equal(routedKristina.BOOKING_SOURCE_KEY, 'kristina-website');
assert.equal(routedKristina.BOOKING_FORM_VERSION, 'booking-v1');
assert.equal(routedKristina.SENTINEL_BINDING, sentinel);

const routedVladimir = withTrustedStagingBookingEnv({
  BOOKING_SOURCE_KEY: 'kristina-website',
}, VLADIMIR_STAGING_ORIGIN);
assert.equal(routedVladimir.BOOKING_SOURCE_KEY, 'vladimir-staging');
assert.equal(routedVladimir.BOOKING_FORM_VERSION, 'booking-v1');

console.log('staging booking routing tests passed');
