// Production entrypoint wrapper for the public tattooai Worker.
//
// Platform-owned public surfaces are dispatched before the legacy router.
// `/book/{artist-slug}` is the canonical human-facing booking route behind the
// root-domain edge. `/forms/{uuid}` remains the legacy hosted compatibility path.
// Enquiry AI queue draining is not scheduled here. Production invokes the
// bounded EnquiryAiService entrypoint from the existing shared CRM scheduler.

import { WorkerEntrypoint } from 'cloudflare:workers';
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

const SAFE_CODE = /^[a-z][a-z0-9_]{2,63}$/;

export class EnquiryAiService extends WorkerEntrypoint {
  async drainEnquiryAiJobs() {
    if (this.env?.VISHAR_ENVIRONMENT !== 'production') {
      return { ok: true, processed: 0 };
    }
    const result = await drainEnquiryAi(this.env, { limit: 3 });
    const processed = Number.isInteger(result?.processed)
      ? Math.min(3, Math.max(0, result.processed))
      : 0;
    if (result?.errorCode) {
      return {
        ok: false,
        processed,
        errorCode: SAFE_CODE.test(result.errorCode) ? result.errorCode : 'enquiry_ai_drain_failed',
      };
    }
    return { ok: true, processed };
  }
}

export default {
  async fetch(request, env, ctx) {
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
