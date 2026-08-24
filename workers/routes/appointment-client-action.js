// Public appointment client-action route.
//
// The token in the path is an opaque one-time capability. It selects both the
// appointment and the exact action server-side; the browser never submits an
// appointment id, artist id or action name as authority.
//
// GET is intentionally read-only. Mail/security scanners commonly follow links,
// so a scanner must be able to open the URL without confirming, rescheduling or
// cancelling anything. Only an explicit same-page POST consumes the capability.

import {
  createSupabaseClient,
  SupabaseError,
} from '../lib/supabase.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;
const PATH_RE = /^\/appointments\/respond\/([0-9a-f]{64})\/?$/;
const NAMESPACE_PREFIX = '/appointments/respond/';
const EXPECTED_OUTCOME_BY_ACTION = Object.freeze({
  confirm_attendance: 'attendance_confirmed',
  request_reschedule: 'reschedule_requested',
  cancel: 'cancelled',
});
const ALLOWED_ACTIONS = new Set(Object.keys(EXPECTED_OUTCOME_BY_ACTION));

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  };
}

function page({ title, heading, body, button = null, tone = 'default' }, status = 200) {
  const buttonHtml = button
    ? `<form method="post"><button class="button ${tone === 'danger' ? 'danger' : ''}" type="submit">${escapeHtml(button)}</button></form>`
    : '';

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; background: #f6f6f4; color: #171717; }
    main { max-width: 560px; margin: 0 auto; padding: 56px 20px; }
    .card { background: #fff; border: 1px solid #ddd; border-radius: 16px; padding: 28px; }
    h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.15; }
    p { margin: 0 0 22px; line-height: 1.55; }
    .button { width: 100%; border: 0; border-radius: 10px; padding: 14px 18px; background: #171717; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
    .button.danger { background: #8b1e1e; }
  </style>
</head>
<body><main><section class="card"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p>${buttonHtml}</section></main></body>
</html>`, {
    status,
    headers: securityHeaders(),
  });
}

function unavailable(status = 404) {
  if (status >= 500) {
    return page({
      title: 'Temporarily unavailable',
      heading: 'Please try again',
      body: 'This appointment action is temporarily unavailable. Please try again in a moment.',
    }, 503);
  }
  return page({
    title: 'Link unavailable',
    heading: 'This link is unavailable',
    body: 'The link may have expired or already been used. Please contact the artist if you still need to change your appointment.',
  }, 404);
}

function actionCopy(action, artistName) {
  switch (action) {
    case 'confirm_attendance':
      return {
        title: 'Confirm attendance',
        heading: 'Confirm your appointment',
        body: `Confirm that you plan to attend your appointment with ${artistName}.`,
        button: 'Confirm attendance',
      };
    case 'request_reschedule':
      return {
        title: 'Request a reschedule',
        heading: 'Request a different time',
        body: `Send a reschedule request to ${artistName}. Your current appointment stays booked at its existing time until the artist confirms a new slot.`,
        button: 'Request reschedule',
      };
    case 'cancel':
      return {
        title: 'Cancel appointment',
        heading: 'Cancel your appointment',
        body: `This will cancel your appointment with ${artistName}. This action cannot be undone from this link.`,
        button: 'Cancel appointment',
        tone: 'danger',
      };
    default:
      return null;
  }
}

function successCopy(outcome, artistName) {
  switch (outcome) {
    case 'attendance_confirmed':
      return {
        title: 'Attendance confirmed',
        heading: 'Attendance confirmed',
        body: `Your confirmation has been recorded for your appointment with ${artistName}.`,
      };
    case 'reschedule_requested':
      return {
        title: 'Reschedule requested',
        heading: 'Request sent',
        body: `Your request has been sent to ${artistName}. Your current appointment remains booked until a new time is confirmed.`,
      };
    case 'cancelled':
      return {
        title: 'Appointment cancelled',
        heading: 'Appointment cancelled',
        body: `Your appointment with ${artistName} has been cancelled.`,
      };
    default:
      return null;
  }
}

function normalizeResolverPayload(payload) {
  const row = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
  if (!row || !ALLOWED_ACTIONS.has(row.action)) return null;
  const artistName = typeof row.artist_display_name === 'string'
    ? row.artist_display_name.trim()
    : '';
  if (!artistName || artistName.length > 200) return null;
  return { action: row.action, artistName };
}

function normalizeMutationPayload(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return null;
  if (!ALLOWED_ACTIONS.has(payload.action)) return null;
  if (EXPECTED_OUTCOME_BY_ACTION[payload.action] !== payload.outcome) return null;
  const artistName = typeof payload.artist_display_name === 'string'
    ? payload.artist_display_name.trim()
    : '';
  if (!artistName || artistName.length > 200) return null;
  return { action: payload.action, outcome: payload.outcome, artistName };
}

function mapBackendError(error) {
  if (error instanceof SupabaseError) {
    if (error.status >= 500 || error.status === 429) return unavailable(503);
    return unavailable(404);
  }
  return unavailable(503);
}

export function isAppointmentClientActionPath(request) {
  try {
    return new URL(request.url).pathname.startsWith(NAMESPACE_PREFIX);
  } catch {
    return false;
  }
}

export function readAppointmentClientActionToken(request) {
  try {
    const match = new URL(request.url).pathname.match(PATH_RE);
    const token = match?.[1] ?? '';
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function handleAppointmentClientActionRequest(
  request,
  env,
  { fetchImpl = fetch } = {},
) {
  const token = readAppointmentClientActionToken(request);
  if (!token) return unavailable(404);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...securityHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET, POST, OPTIONS',
      },
    });
  }

  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return new Response('', {
      status: 405,
      headers: {
        ...securityHeaders(),
        Allow: 'GET, HEAD, POST, OPTIONS',
      },
    });
  }

  let supabase;
  try {
    supabase = createSupabaseClient(env, fetchImpl);
  } catch (error) {
    return mapBackendError(error);
  }

  if (request.method === 'POST') {
    try {
      // Deliberately no request body is parsed. The token alone selects the
      // exact action; browser fields can never widen or replace that authority.
      const result = normalizeMutationPayload(await supabase.rpc(
        'service_apply_appointment_client_action',
        { p_token: token },
      ));
      if (!result) return unavailable(503);
      const copy = successCopy(result.outcome, result.artistName);
      return copy ? page(copy) : unavailable(503);
    } catch (error) {
      return mapBackendError(error);
    }
  }

  try {
    const result = normalizeResolverPayload(await supabase.rpc(
      'service_resolve_appointment_client_action',
      { p_token: token },
    ));
    if (!result) return unavailable(503);
    const copy = actionCopy(result.action, result.artistName);
    if (!copy) return unavailable(503);
    const response = page(copy);
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  } catch (error) {
    return mapBackendError(error);
  }
}

export const __testing = {
  TOKEN_RE,
  PATH_RE,
  ALLOWED_ACTIONS,
  EXPECTED_OUTCOME_BY_ACTION,
  normalizeResolverPayload,
  normalizeMutationPayload,
};
