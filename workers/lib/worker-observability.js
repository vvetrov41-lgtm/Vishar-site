// Binds the privacy-safe observability boundary to Worker runtime config.
//
// Configuration is read from the Worker environment only. The DSN is expected
// to arrive as a Worker secret set by a guarded rollout; it is never tracked in
// this repository and is never logged. When Sentry is disabled or the DSN is
// absent or malformed the reporter stays dormant and every capture is a no-op.

import { createOperationalReporter } from './observability.js';
import { createSentryTransport } from './sentry-transport.js';

/**
 * Builds the reporter for one Worker. Bounded production coverage means a
 * caller decides which few events are worth reporting; this helper only decides
 * whether a transport exists at all.
 */
export function createWorkerObservability(env, { fetchImpl = fetch } = {}) {
  const enabled = env?.SENTRY_ENABLED === 'true';
  const emit = createSentryTransport({
    enabled,
    dsn: env?.SENTRY_DSN ?? null,
    release: typeof env?.SENTRY_RELEASE === 'string' ? env.SENTRY_RELEASE : null,
    fetchImpl,
  });
  return createOperationalReporter({ enabled: enabled && emit !== null, emit });
}

/** Maps an HTTP status to the bounded `statusClass` token the sanitizer allows. */
export function statusClass(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown';
  return `${Math.floor(status / 100)}xx`;
}

export const __testing = Object.freeze({ statusClass });
