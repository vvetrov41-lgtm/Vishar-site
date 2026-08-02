// Preview-only entry point for the isolated hosted booking intake.
// Production continues to use workers/tattooai.js unchanged.

import worker from './tattooai.js';
import { isAllowedOriginFor, isMultipartRequest } from './lib/http.js';

function rejectOrigin() {
  return Response.json(
    {
      ok: false,
      error: 'This origin is not allowed.',
      code: 'origin_not_allowed',
    },
    {
      status: 403,
      headers: {
        Vary: 'Origin',
        'Cache-Control': 'no-store',
      },
    }
  );
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    // The preview Custom Domain is dedicated to booking intake. It fails
    // closed before the shared Worker router can emit production CORS headers.
    if (!isAllowedOriginFor(origin, env)) {
      return rejectOrigin();
    }

    if (request.method === 'POST' && !isMultipartRequest(request)) {
      return Response.json(
        {
          ok: false,
          error: 'A multipart booking request is required.',
          code: 'multipart_required',
        },
        {
          status: 415,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            Vary: 'Origin',
          },
        }
      );
    }

    return worker.fetch(request, env, ctx);
  },
};
