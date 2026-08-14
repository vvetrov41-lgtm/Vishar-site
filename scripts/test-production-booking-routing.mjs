#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  VLADIMIR_BOOKING_ORIGIN,
  __testing,
  readTrustedBookingConfigForOrigin,
  readTrustedProductionBookingRoute,
} from '../workers/lib/production-booking-routing.js';

assert.equal(__testing.routeCount, 1);
assert.deepEqual(__testing.origins, [VLADIMIR_BOOKING_ORIGIN]);

assert.deepEqual(readTrustedProductionBookingRoute(VLADIMIR_BOOKING_ORIGIN), {
  sourceKey: 'vladimir-booking-host',
  formVersion: 'booking-v1',
});

for (const origin of [
  '',
  null,
  'http://booking.vishartattoo.com',
  'https://booking.vishartattoo.com.evil.example',
  'https://vishartattoo.com',
  'https://vishar-booking-staging.pages.dev',
]) {
  assert.equal(readTrustedProductionBookingRoute(origin), null, String(origin));
}

const staleEnv = {
  BOOKING_SOURCE_KEY: 'stale-production-source',
  BOOKING_FORM_VERSION: 'stale-production-version',
};
assert.deepEqual(readTrustedBookingConfigForOrigin(staleEnv, VLADIMIR_BOOKING_ORIGIN), {
  sourceKey: 'vladimir-booking-host',
  formVersion: 'booking-v1',
});

const existingProductionEnv = {
  BOOKING_SOURCE_KEY: 'vladimir-website',
  BOOKING_FORM_VERSION: 'booking-v1',
};
assert.deepEqual(
  readTrustedBookingConfigForOrigin(existingProductionEnv, 'https://vishartattoo.com'),
  { sourceKey: 'vladimir-website', formVersion: 'booking-v1' }
);

const stagingEnv = {
  BOOKING_SOURCE_KEY: 'vladimir-staging',
  BOOKING_FORM_VERSION: 'booking-v1',
};
assert.deepEqual(
  readTrustedBookingConfigForOrigin(stagingEnv, 'https://vishar-booking-staging.pages.dev'),
  { sourceKey: 'vladimir-staging', formVersion: 'booking-v1' }
);

console.log('production booking routing tests passed');
