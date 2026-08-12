// Retained-staging booking source routing.
//
// The public form never selects an artist, source key, provider account or
// integration route. The preview Worker derives the trusted source solely from
// the exact request Origin after that Origin has passed the deployment-level
// allow-list in workers/preview.js.

export const VLADIMIR_STAGING_ORIGIN = 'https://vishar-booking-staging.pages.dev';
export const KRISTINA_STAGING_ORIGIN = 'https://agent-kristina-booking-crm-setup-kisa.vvetrov41.workers.dev';

const FORM_VERSION = 'booking-v1';

const ROUTES = new Map([
  [
    VLADIMIR_STAGING_ORIGIN,
    Object.freeze({
      sourceKey: 'vladimir-staging',
      formVersion: FORM_VERSION,
    }),
  ],
  [
    KRISTINA_STAGING_ORIGIN,
    Object.freeze({
      sourceKey: 'kristina-website',
      formVersion: FORM_VERSION,
    }),
  ],
]);

export function readTrustedStagingBookingRoute(origin) {
  if (typeof origin !== 'string') return null;
  return ROUTES.get(origin) || null;
}

export function withTrustedStagingBookingEnv(env, origin) {
  const route = readTrustedStagingBookingRoute(origin);
  if (!route) return null;

  return {
    ...(env || {}),
    // The shared intake Worker sees one exact origin and one server-selected
    // source for this request. Stale scalar deployment vars cannot override
    // the route selected by the preview boundary.
    ALLOWED_ORIGINS: origin,
    BOOKING_SOURCE_KEY: route.sourceKey,
    BOOKING_FORM_VERSION: route.formVersion,
  };
}

export const __testing = Object.freeze({
  routeCount: ROUTES.size,
  origins: Object.freeze([...ROUTES.keys()]),
});
