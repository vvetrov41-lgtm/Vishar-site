// Production entrypoint wrapper for the public tattooai Worker.
//
// Platform-owned same-origin public surfaces are dispatched before the legacy
// router. Everything else is delegated unchanged.
//
// Hosted booking forms own `/forms/`. Appointment client actions own
// `/appointments/respond/`. Both namespaces include malformed identifiers so a
// bad id cannot fall through to a different 404 surface. Appointment GET is
// read-only and only POST can consume its one-time capability.
//
// The legacy router also computes CORS before it knows whether a request is a
// registry-backed booking request. A browser FormData POST reaches the durable
// route without preflight, but an external site that legitimately triggers
// OPTIONS must receive the same dynamic CORS plumbing.

import tattooai from './tattooai.js';
import { getCorsHeaders, isRegistryBookingRequest } from './lib/http.js';
import { handleHostedBookingRequest, isHostedBookingPath } from './routes/hosted-booking.js';
import {
  handleAppointmentClientActionRequest,
  isAppointmentClientActionPath,
} from './routes/appointment-client-action.js';

export default {
  async fetch(request, env, ctx) {
    if (isAppointmentClientActionPath(request)) {
      return handleAppointmentClientActionRequest(request, env, {});
    }

    if (isHostedBookingPath(request)) {
      return handleHostedBookingRequest(request, env, {});
    }

    if (request.method === 'OPTIONS' && isRegistryBookingRequest(request)) {
      const origin = request.headers.get('Origin') || '';
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(origin, env, request),
      });
    }

    return tattooai.fetch(request, env, ctx);
  },
};
