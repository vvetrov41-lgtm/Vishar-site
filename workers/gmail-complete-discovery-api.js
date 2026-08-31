import {
  deleteRefreshToken,
  getProfile,
  refreshAccessToken,
} from './lib/google-gmail.js';
import { createGmailSupabase } from './lib/gmail-supabase.js';

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const GMAIL_PUBLIC_HOST = 'gmail.vishartattoo.com';
const CRM_ORIGIN = 'https://crm.vishartattoo.com';
const REQUIRED_OPERATOR_CAPABILITY = 'manage_communications';
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function safeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email) && email.length <= 254 ? email : null;
}

function safeProviderId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,255}$/.test(value) ? value : null;
}

function safeHeader(value, max = 998) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,8192})$/.exec(request.headers.get('authorization') || '');
  return match?.[1] || null;
}

function corsHeaders(request) {
  return request.headers.get('origin') === CRM_ORIGIN
    ? { 'access-control-allow-origin': CRM_ORIGIN, vary: 'Origin' }
    : {};
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request) },
  });
}

function methodNotAllowed(request, allow) {
  return new Response(null, {
    status: 405,
    headers: { allow, 'cache-control': 'no-store', ...corsHeaders(request) },
  });
}

function configured(env) {
  return env?.VISHAR_ENVIRONMENT === 'production'
    && env?.SUPABASE_URL === PRODUCTION_SUPABASE_ORIGIN
    && env?.GMAIL_READ_ENABLED === 'true';
}

async function enforceRateLimit(request, env) {
  if (!env?.GMAIL_RATE_LIMIT?.limit) return false;
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await env.GMAIL_RATE_LIMIT.limit({ key: `operator:${address}` });
  return result?.success === false;
}

async function authorizeOperatorForArtist(db, token, artistId) {
  const capabilities = await db.userRpc('list_capabilities', { p_artist_id: artistId }, token);
  if (!Array.isArray(capabilities)
    || !capabilities.some((row) => row?.artist_id === artistId && row?.capability === REQUIRED_OPERATOR_CAPABILITY)) {
    throw new Error('gmail_operator_scope_invalid');
  }
  return { artist_id: artistId };
}

async function resolveMailbox(db, artistId) {
  const mailbox = firstRow(await db.backendRpc('service_resolve_gmail_mailbox', { p_artist_id: artistId }));
  if (!mailbox || mailbox.artist_id !== artistId || typeof mailbox.mailbox_email !== 'string') {
    throw new Error('gmail_target_scope_invalid');
  }
  return mailbox;
}

async function accessForTarget(env, db, target, fetchImpl) {
  try {
    const { accessToken, stored } = await refreshAccessToken(env, target.artist_id, fetchImpl);
    if (stored.integration_key !== target.integration_key || stored.mailbox_email !== target.mailbox_email) {
      throw new Error('gmail_token_binding_mismatch');
    }
    const profile = await getProfile(accessToken, fetchImpl);
    if (profile.emailAddress !== target.mailbox_email) throw new Error('gmail_profile_binding_mismatch');
    return accessToken;
  } catch (error) {
    if (error instanceof Error && error.message === 'gmail_refresh_token_revoked') {
      try {
        await db.backendRpc('service_disable_gmail_integration', {
          p_artist_id: target.artist_id,
          p_integration_key: target.integration_key,
          p_error_code: 'gmail_refresh_token_revoked',
        });
      } finally {
        await deleteRefreshToken(env, target.artist_id);
      }
    }
    throw error;
  }
}

async function gmailFetch(path, accessToken, fetchImpl) {
  const response = await fetchImpl(`${GMAIL_API_ORIGIN}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: 'manual',
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    const error = new Error(response.status === 401 ? 'gmail_access_token_rejected' : 'gmail_api_error');
    error.providerStatus = response.status;
    throw error;
  }
  return body;
}

function headerMap(headers) {
  const map = new Map();
  for (const header of Array.isArray(headers) ? headers : []) {
    const name = String(header?.name || '').toLowerCase();
    if (!map.has(name) && typeof header?.value === 'string') map.set(name, header.value);
  }
  return map;
}

function extractEmails(value) {
  const results = new Set();
  const matches = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const candidate of matches) {
    const email = safeEmail(candidate);
    if (email) results.add(email);
  }
  return results;
}

function messageTimestamp(message, headers) {
  if (Number.isFinite(Number(message?.internalDate))) {
    return new Date(Number(message.internalDate)).toISOString();
  }
  const parsed = Date.parse(headers.get('date') || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function correspondentFromMetadata(message, mailboxEmail) {
  const mailbox = safeEmail(mailboxEmail);
  if (!mailbox) return null;
  const headers = headerMap(message?.payload?.headers);
  const fromEmails = extractEmails(headers.get('from'));
  const toEmails = extractEmails(headers.get('to'));

  let counterpart = null;
  let direction = null;
  if (toEmails.has(mailbox) && !fromEmails.has(mailbox)) {
    for (const email of fromEmails) {
      if (email !== mailbox) { counterpart = email; break; }
    }
    direction = 'inbound';
  } else if (fromEmails.has(mailbox)) {
    for (const email of toEmails) {
      if (email !== mailbox) { counterpart = email; break; }
    }
    direction = 'outbound';
  }
  if (!counterpart || counterpart === mailbox) return null;

  return {
    email: counterpart,
    subject: safeHeader(headers.get('subject')) || '(no subject)',
    timestamp: messageTimestamp(message, headers),
    direction,
  };
}

async function listCompleteRecentCorrespondents(accessToken, {
  mailboxEmail,
  newerThanDays = 30,
  fetchImpl = fetch,
} = {}) {
  const mailbox = safeEmail(mailboxEmail);
  if (!mailbox) throw new Error('gmail_mailbox_email_invalid');
  const days = Math.max(1, Math.min(Number(newerThanDays) || 30, 90));
  const query = `newer_than:${days}d -in:drafts -in:chats -in:spam -in:trash`;
  const seenTokens = new Set();
  const seenMessageIds = new Set();
  const correspondents = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({ maxResults: '500', q: query });
    if (pageToken) params.set('pageToken', pageToken);
    const listing = await gmailFetch(`/gmail/v1/users/me/messages?${params.toString()}`, accessToken, fetchImpl);
    const ids = (Array.isArray(listing.messages) ? listing.messages : [])
      .map((message) => safeProviderId(message?.id))
      .filter(Boolean);

    for (const id of ids) {
      if (seenMessageIds.has(id)) continue;
      seenMessageIds.add(id);
      let message;
      try {
        message = await gmailFetch(
          `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`
          + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',
          accessToken,
          fetchImpl,
        );
      } catch {
        continue;
      }
      const item = correspondentFromMetadata(message, mailbox);
      if (item) correspondents.push(item);
    }

    const next = typeof listing.nextPageToken === 'string' && listing.nextPageToken
      ? listing.nextPageToken
      : null;
    if (!next) break;
    if (seenTokens.has(next)) throw new Error('gmail_discovery_pagination_loop');
    seenTokens.add(next);
    pageToken = next;
  } while (pageToken);

  return correspondents;
}

async function matchKnownClients(db, artistId, seen) {
  const emails = [...new Set(seen.map((item) => safeEmail(item?.email)).filter(Boolean))];
  const matched = [];
  for (let offset = 0; offset < emails.length; offset += 200) {
    const rows = await db.backendRpc('service_match_gmail_clients', {
      p_artist_id: artistId,
      p_emails: emails.slice(offset, offset + 200),
    });
    if (Array.isArray(rows)) matched.push(...rows);
  }
  return matched;
}

function buildPublicClients(seen, matched) {
  const byEmail = new Map(
    (Array.isArray(matched) ? matched : [])
      .filter((row) => uuid(row?.client_id) && safeEmail(row?.client_email))
      .map((row) => [safeEmail(row.client_email), row]),
  );
  const latest = new Map();
  for (const item of seen) {
    const client = byEmail.get(safeEmail(item?.email));
    if (!client) continue;
    const current = latest.get(client.client_id);
    const at = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
    const currentAt = current?.last_message_at ? Date.parse(current.last_message_at) : Number.NaN;
    if (!current || (Number.isFinite(at) && (!Number.isFinite(currentAt) || at > currentAt))) {
      latest.set(client.client_id, {
        client_id: client.client_id,
        client_name: typeof client.full_name === 'string' ? client.full_name : null,
        subject: item.subject,
        last_message_at: item.timestamp,
        direction: item.direction,
        untrusted_content: true,
      });
    }
  }
  return [...latest.values()];
}

function safeReason(error) {
  return error instanceof Error ? error.message : 'gmail_operator_failed';
}

function errorResponse(request, error) {
  const reason = safeReason(error);
  if (reason === 'gmail_operator_token_invalid' || reason === 'gmail_operator_unauthorized') {
    return json(request, 401, { error: 'authentication_required' });
  }
  if (
    reason === 'gmail_rpc_forbidden'
    || reason === 'gmail_operator_scope_invalid'
    || reason === 'gmail_target_scope_invalid'
    || reason === 'gmail_token_binding_mismatch'
    || reason.includes('scope')
  ) {
    return json(request, 403, { error: 'artist_scope_denied' });
  }
  if (reason === 'gmail_refresh_token_missing' || reason === 'gmail_refresh_token_revoked') {
    return json(request, 409, { error: 'gmail_reconnect_required' });
  }
  return json(request, 502, { error: 'gmail_provider_unavailable' });
}

export async function handleCompleteGmailDiscoveryRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.hostname !== GMAIL_PUBLIC_HOST) return null;
  const discovery = /^\/v1\/operator\/artists\/([0-9a-f-]{36})\/gmail\/inbox\/?$/i.exec(url.pathname);
  if (!discovery) return null;

  const origin = request.headers.get('origin');
  if (origin && origin !== CRM_ORIGIN) return json(request, 403, { error: 'origin_denied' });
  if (request.method === 'OPTIONS') {
    if (origin !== CRM_ORIGIN) return json(request, 403, { error: 'origin_denied' });
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': CRM_ORIGIN,
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
        vary: 'Origin',
      },
    });
  }
  if (!configured(env)) return json(request, 404, { error: 'not_found' });
  if (await enforceRateLimit(request, env)) return json(request, 429, { error: 'rate_limited' });
  if (request.method !== 'GET') return methodNotAllowed(request, 'GET, OPTIONS');

  const token = bearer(request);
  if (!token) return json(request, 401, { error: 'authentication_required' });
  const artistId = uuid(discovery[1]);
  if (!artistId) return json(request, 400, { error: 'invalid_artist_id' });
  for (const key of url.searchParams.keys()) {
    if (key !== 'message_limit') return json(request, 400, { error: 'unexpected_field', field: key });
  }
  if (url.searchParams.has('message_limit')) {
    const legacyLimit = Number(url.searchParams.get('message_limit'));
    if (!Number.isInteger(legacyLimit) || legacyLimit < 1 || legacyLimit > 60) {
      return json(request, 400, { error: 'invalid_limit' });
    }
  }

  try {
    const db = createGmailSupabase(env, fetchImpl);
    const auth = await authorizeOperatorForArtist(db, token, artistId);
    const mailbox = await resolveMailbox(db, auth.artist_id);
    const accessToken = await accessForTarget(env, db, {
      artist_id: auth.artist_id,
      integration_key: mailbox.integration_key,
      mailbox_email: mailbox.mailbox_email,
    }, fetchImpl);

    // Complete the defined 30-day discovery window. The old path stopped after
    // 40-60 arbitrary mailbox messages, so a known client's older unread mail
    // disappeared as unrelated traffic arrived. Provider ids stay inside this
    // function; only metadata is fetched, and drafts are excluded in Gmail.
    const seen = await listCompleteRecentCorrespondents(accessToken, {
      mailboxEmail: mailbox.mailbox_email,
      fetchImpl,
    });
    const matched = seen.length ? await matchKnownClients(db, auth.artist_id, seen) : [];

    // The database remains the authority for who is a client. Unknown sender
    // metadata is never copied into the response and nothing is written.
    return json(request, 200, {
      artist_id: auth.artist_id,
      clients: buildPublicClients(seen, matched),
      untrusted_content: true,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export const __testing = Object.freeze({
  GMAIL_PUBLIC_HOST,
  CRM_ORIGIN,
  REQUIRED_OPERATOR_CAPABILITY,
  safeEmail,
  safeProviderId,
  correspondentFromMetadata,
  listCompleteRecentCorrespondents,
  matchKnownClients,
  buildPublicClients,
});
