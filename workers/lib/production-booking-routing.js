// Production booking-source routing.
//
// Public form fields never select an artist or source key. The Worker derives
// the trusted booking source only from the exact request Origin after the
// normal deployment-level ALLOWED_ORIGINS check has passed.

export const VLADIMIR_PRODUCTION_ORIGIN = 'https://vishartattoo.com';
export const VLADIMIR_BOOKING_PRODUCTION_ORIGIN = 'https://booking.vishartattoo.com';
export const KRISTINA_PRODUCTION_ORIGIN = 'https://www.kristinavishar.com';

const FORM_VERSION = 'booking-v1';

const ROUTES = new Map([
  [
    VLADIMIR_PRODUCTION_ORIGIN,
    Object.freeze({ sourceKey: 'vladimir-website', formVersion: FORM_VERSION }),
  ],
  [
    VLADIMIR_BOOKING_PRODUCTION_ORIGIN,
    Object.freeze({ sourceKey: 'vladimir-website', formVersion: FORM_VERSION }),
  ],
  [
    KRISTINA_PRODUCTION_ORIGIN,
    Object.freeze({ sourceKey: 'kristina-website', formVersion: FORM_VERSION }),
  ],
]);

export function readTrustedProductionBookingRoute(origin) {
  if (typeof origin !== 'string') return null;
  return ROUTES.get(origin) || null;
}

export function withTrustedProductionBookingEnv(env, origin) {
  const route = readTrustedProductionBookingRoute(origin);
  if (!route) return null;

  return {
    ...(env || {}),
    // Stale scalar dashboard variables cannot override the source selected by
    // the exact production-origin boundary.
    BOOKING_SOURCE_KEY: route.sourceKey,
    BOOKING_FORM_VERSION: route.formVersion,
  };
}

export const __testing = Object.freeze({
  routeCount: ROUTES.size,
  origins: Object.freeze([...ROUTES.keys()]),
});
