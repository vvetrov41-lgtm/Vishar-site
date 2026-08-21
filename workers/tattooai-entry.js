// Production entrypoint wrapper for the public tattooai Worker.
//
// The legacy router predates database-backed booking sources and computes CORS
// before it knows whether a request is a registry-backed booking request. A
// browser FormData POST reaches the durable route without preflight, but an
// external site that legitimately triggers OPTIONS must receive the same
// dynamic CORS plumbing. This wrapper handles only that OPTIONS case and
// delegates every other request unchanged.

import tattooai from './tattooai.js';
import { getCorsHeaders, isRegistryBookingRequest } from './lib/http.js';

export default {
  async fetch(request, env, ctx) {
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
