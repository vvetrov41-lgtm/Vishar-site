// Production entrypoint wrapper for the public tattooai Worker.
//
// Platform-owned public surfaces are dispatched before the legacy router.
// `/book/{artist-slug}` is the canonical human-facing booking route behind the
// root-domain edge. `/forms/{uuid}` remains the legacy hosted compatibility path.

import tattooai from './tattooai.js';
import { getCorsHeaders, isRegistryBookingRequest } from './lib/http.js';
import { handleHostedBookingRequest, isHostedBookingPath } from './routes/hosted-booking.js';
import { handlePublicBookingRequest, isPublicBookingPath } from './routes/public-booking.js';
import {
  handleAppointmentClientActionRequest,
  isAppointmentClientActionPath,
} from './routes/appointment-client-action.js';

export default {
  async fetch(request, env, ctx) {
    if (isAppointmentClientActionPath(request)) {
      return handleAppointmentClientActionRequest(request, env, {});
    }

    if (isPublicBookingPath(request)) {
      return handlePublicBookingRequest(request, env, {});
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
