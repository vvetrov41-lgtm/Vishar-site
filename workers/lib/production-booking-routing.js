// Production-only booking source routing for dedicated booking hosts.
//
// The browser never selects a source key, artist, provider route or form
// version. For a dedicated production booking hostname we derive the trusted
// source solely from the exact request Origin after the intake route has passed
// the normal origin allow-list. Existing production and retained-staging flows
// keep their current deployment-provided booking configuration.

import { readTrustedBookingConfig } from './provider-routing.js';

export const VLADIMIR_BOOKING_ORIGIN = 'https://booking.vishartattoo.com';

const ROUTES = new Map([
  [
    VLADIMIR_BOOKING_ORIGIN,
    Object.freeze({
      sourceKey: 'vladimir-booking-host',
      formVersion: 'booking-v1',
    }),
  ],
]);

export function readTrustedProductionBookingRoute(origin) {
  if (typeof origin !== 'string') return null;
  return ROUTES.get(origin) || null;
}

export function readTrustedBookingConfigForOrigin(env, origin) {
  return readTrustedProductionBookingRoute(origin) || readTrustedBookingConfig(env);
}

export const __testing = Object.freeze({
  routeCount: ROUTES.size,
  origins: Object.freeze([...ROUTES.keys()]),
});
