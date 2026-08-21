// Production entrypoint wrapper for the public tattooai Worker.
//
// Two things happen here that the legacy router cannot do, and everything else
// is delegated to it unchanged.
//
// Hosted booking forms own the `/forms/` path namespace. The legacy router
// predates them entirely and would answer a hosted URL with its own 404, so the
// hosted route is dispatched first. It is deliberately checked before the CORS
// branch below: a hosted form is served from this Worker and posts back to
// itself, so it is same-origin and must not be handed cross-origin CORS
// headers it has no use for.
//
// The legacy router also computes CORS before it knows whether a request is a
// registry-backed booking request. A browser FormData POST reaches the durable
// route without preflight, but an external site that legitimately triggers
// OPTIONS must receive the same dynamic CORS plumbing.

import tattooai from './tattooai.js';
import { getCorsHeaders, isRegistryBookingRequest } from './lib/http.js';
import { handleHostedBookingRequest, isHostedBookingPath } from './routes/hosted-booking.js';

export default {
  async fetch(request, env, ctx) {
    // The whole `/forms/` namespace belongs to hosted booking forms, including
    // a malformed id: falling through to the legacy router for those would
    // leak a different 404 surface and tell a prober which ids exist.
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
