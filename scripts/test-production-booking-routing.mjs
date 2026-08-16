import assert from 'node:assert/strict';
import {
  KRISTINA_PRODUCTION_ORIGIN,
  VLADIMIR_BOOKING_PRODUCTION_ORIGIN,
  VLADIMIR_PRODUCTION_ORIGIN,
  __testing,
  readTrustedProductionBookingRoute,
  withTrustedProductionBookingEnv,
} from '../workers/lib/production-booking-routing.js';

assert.equal(__testing.routeCount, 3);
assert.deepEqual(new Set(__testing.origins), new Set([
  VLADIMIR_PRODUCTION_ORIGIN,
  VLADIMIR_BOOKING_PRODUCTION_ORIGIN,
  KRISTINA_PRODUCTION_ORIGIN,
]));

assert.deepEqual(readTrustedProductionBookingRoute(KRISTINA_PRODUCTION_ORIGIN), {
  sourceKey: 'kristina-website',
  formVersion: 'booking-v1',
});
assert.deepEqual(readTrustedProductionBookingRoute(VLADIMIR_PRODUCTION_ORIGIN), {
  sourceKey: 'vladimir-website',
  formVersion: 'booking-v1',
});
assert.deepEqual(readTrustedProductionBookingRoute(VLADIMIR_BOOKING_PRODUCTION_ORIGIN), {
  sourceKey: 'vladimir-website',
  formVersion: 'booking-v1',
});

for (const origin of [
  'https://kristinavishar.com',
  'http://www.kristinavishar.com',
  'https://www.kristinavishar.com.evil.example',
  'https://vishartattoo.com.evil.example',
  '',
]) {
  assert.equal(readTrustedProductionBookingRoute(origin), null, origin);
}

const routed = withTrustedProductionBookingEnv({
  VISHAR_ENVIRONMENT: 'production',
  ALLOWED_ORIGINS: KRISTINA_PRODUCTION_ORIGIN,
  BOOKING_SOURCE_KEY: 'stale-source',
  BOOKING_FORM_VERSION: 'stale-version',
  SUPABASE_URL: 'https://example.supabase.co',
}, KRISTINA_PRODUCTION_ORIGIN);

assert.equal(routed.BOOKING_SOURCE_KEY, 'kristina-website');
assert.equal(routed.BOOKING_FORM_VERSION, 'booking-v1');
assert.equal(routed.ALLOWED_ORIGINS, KRISTINA_PRODUCTION_ORIGIN);
assert.equal(routed.SUPABASE_URL, 'https://example.supabase.co');
assert.equal(withTrustedProductionBookingEnv({}, 'https://unknown.example'), null);

console.log('Production booking routing tests passed.');
