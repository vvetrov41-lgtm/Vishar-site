// Production entrypoint wrapper for the public tattooai Worker.
//
// Platform-owned public surfaces are dispatched before the legacy router.
// `/book/{artist-slug}` is the canonical human-facing booking route behind the
// root-domain edge. `/forms/{uuid}` remains the legacy hosted compatibility path.

import tattooai from './tattooai.js';
import { drainEnquiryAi } from './lib/enquiry-ai.js';
import { getCorsHeaders, isRegistryBookingRequest } from './lib/http.js';
import { handleHostedBookingRequest, isHostedBookingPath } from './routes/hosted-booking.js';
import { handlePublicBookingRequest, isPublicBookingPath } from './routes/public-booking.js';
import {
  handleAppointmentClientActionRequest,
  isAppointmentClientActionPath,
} from './routes/appointment-client-action.js';
import {
  handleAiRouterProbeRequest,
  isAiRouterProbePath,
} from './routes/ai-router-probe.js';

function scheduleEnquiryAiDrain(env, ctx) {
  if (typeof ctx?.waitUntil !== 'function') return;
  ctx.waitUntil(drainEnquiryAi(env, { limit: 3 }));
}

export default {
  async scheduled(_event, env, ctx) {
    scheduleEnquiryAiDrain(env, ctx);
  },
  async fetch(request, env, ctx) {
    // Scheduled Triggers are the primary queue consumer, but production intake
    // must not stall if Cloudflare schedule mutation is temporarily unavailable.
    // The database claim RPC is lease-safe, so opportunistic drains on normal
    // Worker traffic cannot process the same job twice and never delay the HTTP
    // response because execution is attached to waitUntil().
    scheduleEnquiryAiDrain(env, ctx);

    // Operator-only model-routing readback. Answers 404 unless explicitly
    // enabled and token-authenticated, and never emits CORS headers.
    if (isAiRouterProbePath(request)) {
      return handleAiRouterProbeRequest(request, env, { fetchImpl: fetch });
    }

    if (isAppointmentClientActionPath(request)) {
      return handleAppointmentClientActionRequest(request, env, {});
    }

    if (isPublicBookingPath(request)) {
      return handlePublicBookingRequest(request, env, { schedule: (promise) => ctx.waitUntil(promise) });
    }

    if (isHostedBookingPath(request)) {
      return handleHostedBookingRequest(request, env, { schedule: (promise) => ctx.waitUntil(promise) });
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
