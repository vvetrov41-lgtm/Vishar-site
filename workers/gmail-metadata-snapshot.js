import { refreshAccessToken, getProfile } from './lib/google-gmail.js';

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
const CRM_ORIGIN = 'https://crm.vishartattoo.com';
const GMAIL_PUBLIC_HOST = 'gmail.vishartattoo.com';
const METADATA_CONCURRENCY = 5;
const PROVIDER_TIMEOUT_MS = 5000;
const SNAPSHOT_WINDOW_DAYS = 30;

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
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
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...corsHeaders(request),
    },
  });
}

function projectOrigin(env) {
  const value = String(env?.SUPABASE_URL || '').trim();
  let url;
  try { url = new URL(value); } catch { throw new Error('gmail_supabase_url_invalid'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)) {
    throw new Error('gmail_supabase_url_invalid');
  }
  return url.origin;
}

function secretKey(env) {
  const value = String(env?.SUPABASE_SECRET_KEY || '').trim();
  if (!value.startsWith('sb_secret_')) throw new Error('gmail_supabase_secret_unavailable');
  return value;
}

function publishableKey(env) {
  const value = String(env?.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!value.startsWith('sb_publishable_')) throw new Error('gmail_supabase_publishable_unavailable');
  return value;
}

async function supabaseJson(url, init, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...init, redirect: 'manual' });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? 'gmail_snapshot_forbidden'
      : 'gmail_snapshot_backend_failed');
    error.status = response.status;
    throw error;
  }
  return body;
}

async function gmailJson(path, accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(`${GMAIL_API_ORIGIN}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error('gmail_provider_unavailable');
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
  for (const candidate of String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) {
    const email = safeEmail(candidate);
    if (email) results.add(email);
  }
  return results;
}

function metadataCorrespondent(message, mailboxEmail) {
  const mailbox = safeEmail(mailboxEmail);
  if (!mailbox) return null;
  const headers = headerMap(message?.payload?.headers);
  const from = extractEmails(headers.get('from'));
  const to = extractEmails(headers.get('to'));
  let email = null;
  let direction = null;
  if (to.has(mailbox) && !from.has(mailbox)) {
    email = [...from].find((candidate) => candidate !== mailbox) || null;
    direction = 'inbound';
  } else if (from.has(mailbox)) {
    email = [...to].find((candidate) => candidate !== mailbox) || null;
    direction = 'outbound';
  }
  if (!email) return null;
  const internal = Number(message?.internalDate);
  const parsedDate = Date.parse(headers.get('date') || '');
  const timestamp = Number.isFinite(internal)
    ? new Date(internal).toISOString()
    : Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null;
  return {
    email,
    subject: safeHeader(headers.get('subject')) || '(no subject)',
    timestamp,
    direction,
  };
}

async function listRecentMetadata(accessToken, mailboxEmail, fetchImpl = fetch) {
  const query = `newer_than:${SNAPSHOT_WINDOW_DAYS}d -in:drafts -in:chats -in:spam -in:trash`;
  const seenTokens = new Set();
  const seenIds = new Set();
  const rows = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ maxResults: '500', q: query });
    if (pageToken) params.set('pageToken', pageToken);
    const listing = await gmailJson(`/gmail/v1/users/me/messages?${params}`, accessToken, fetchImpl);
    const ids = (Array.isArray(listing.messages) ? listing.messages : [])
      .map((item) => safeProviderId(item?.id))
      .filter((id) => id && !seenIds.has(id));
    ids.forEach((id) => seenIds.add(id));
    for (let offset = 0; offset < ids.length; offset += METADATA_CONCURRENCY) {
      const batch = ids.slice(offset, offset + METADATA_CONCURRENCY);
      const values = await Promise.all(batch.map(async (id) => {
        try {
          const message = await gmailJson(
            `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`
              + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',
            accessToken,
            fetchImpl,
          );
          return metadataCorrespondent(message, mailboxEmail);
        } catch { return null; }
      }));
      rows.push(...values.filter(Boolean));
    }
    const next = typeof listing.nextPageToken === 'string' && listing.nextPageToken
      ? listing.nextPageToken : null;
    if (!next) break;
    if (seenTokens.has(next)) throw new Error('gmail_discovery_pagination_loop');
    seenTokens.add(next);
    pageToken = next;
  } while (pageToken);
  return rows;
}

async function serviceRpc(env, name, args, fetchImpl = fetch) {
  const origin = projectOrigin(env);
  return supabaseJson(`${origin}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: secretKey(env), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(args || {}),
  }, fetchImpl);
}

async function listEnabledMailboxes(env, fetchImpl = fetch) {
  const url = new URL('/rest/v1/artist_integrations', projectOrigin(env));
  url.searchParams.set('select', 'artist_id,integration_key,external_account_label');
  url.searchParams.set('integration_type', 'eq.email');
  url.searchParams.set('provider', 'eq.google');
  url.searchParams.set('is_enabled', 'eq.true');
  const rows = await supabaseJson(url, {
    method: 'GET', headers: { apikey: secretKey(env), accept: 'application/json' },
  }, fetchImpl);
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    uuid(row?.artist_id) && typeof row?.integration_key === 'string' && safeEmail(row?.external_account_label));
}

async function matchKnownClients(env, artistId, metadata, fetchImpl = fetch) {
  const emails = [...new Set(metadata.map((row) => safeEmail(row?.email)).filter(Boolean))];
  const matched = [];
  for (let offset = 0; offset < emails.length; offset += 200) {
    const rows = await serviceRpc(env, 'service_match_gmail_clients', {
      p_artist_id: artistId,
      p_emails: emails.slice(offset, offset + 200),
    }, fetchImpl);
    if (Array.isArray(rows)) matched.push(...rows);
  }
  return matched;
}

function latestKnownRows(artistId, metadata, matched, refreshedAt) {
  const byEmail = new Map((Array.isArray(matched) ? matched : [])
    .filter((row) => uuid(row?.client_id) && safeEmail(row?.client_email))
    .map((row) => [safeEmail(row.client_email), row]));
  const latest = new Map();
  for (const item of metadata) {
    const client = byEmail.get(safeEmail(item?.email));
    if (!client) continue;
    const current = latest.get(client.client_id);
    const at = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
    const currentAt = current?.last_message_at ? Date.parse(current.last_message_at) : Number.NaN;
    if (!current || (Number.isFinite(at) && (!Number.isFinite(currentAt) || at > currentAt))) {
      latest.set(client.client_id, {
        artist_id: artistId,
        client_id: client.client_id,
        subject: item.subject,
        last_message_at: item.timestamp,
        direction: item.direction,
        refreshed_at: refreshedAt,
      });
    }
  }
  return [...latest.values()];
}

async function persistSnapshot(env, artistId, rows, refreshedAt, fetchImpl = fetch) {
  const origin = projectOrigin(env);
  const headers = { apikey: secretKey(env), 'content-type': 'application/json', accept: 'application/json' };
  if (rows.length) {
    const upsert = new URL('/rest/v1/gmail_client_metadata_snapshots', origin);
    upsert.searchParams.set('on_conflict', 'artist_id,client_id');
    await supabaseJson(upsert, {
      method: 'POST',
      headers: { ...headers, prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    }, fetchImpl);
  }
  const stale = new URL('/rest/v1/gmail_client_metadata_snapshots', origin);
  stale.searchParams.set('artist_id', `eq.${artistId}`);
  stale.searchParams.set('refreshed_at', `lt.${refreshedAt}`);
  await supabaseJson(stale, { method: 'DELETE', headers: { ...headers, prefer: 'return=minimal' } }, fetchImpl);
}

export async function refreshGmailMetadataSnapshots(env, fetchImpl = fetch) {
  if (env?.VISHAR_ENVIRONMENT !== 'production' || env?.GMAIL_READ_ENABLED !== 'true') {
    return { skipped: true, artists: 0, refreshed: 0, failed: 0 };
  }
  const mailboxes = await listEnabledMailboxes(env, fetchImpl);
  let refreshed = 0;
  let failed = 0;
  for (const mailbox of mailboxes) {
    try {
      const { accessToken, stored } = await refreshAccessToken(env, mailbox.artist_id, fetchImpl);
      if (stored.integration_key !== mailbox.integration_key
          || stored.mailbox_email !== safeEmail(mailbox.external_account_label)) {
        throw new Error('gmail_token_binding_mismatch');
      }
      const profile = await getProfile(accessToken, fetchImpl);
      if (safeEmail(profile.emailAddress) !== safeEmail(mailbox.external_account_label)) {
        throw new Error('gmail_profile_binding_mismatch');
      }
      const metadata = await listRecentMetadata(accessToken, mailbox.external_account_label, fetchImpl);
      const matched = metadata.length
        ? await matchKnownClients(env, mailbox.artist_id, metadata, fetchImpl) : [];
      const refreshedAt = new Date().toISOString();
      const rows = latestKnownRows(mailbox.artist_id, metadata, matched, refreshedAt);
      await persistSnapshot(env, mailbox.artist_id, rows, refreshedAt, fetchImpl);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      console.error('gmail metadata snapshot refresh failed', JSON.stringify({
        artist_id: mailbox.artist_id,
        code: error instanceof Error ? error.message : 'gmail_metadata_refresh_failed',
      }));
    }
  }
  return { skipped: false, artists: mailboxes.length, refreshed, failed };
}

export async function handleCachedGmailDiscoveryRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.hostname !== GMAIL_PUBLIC_HOST) return null;
  const match = /^\/v1\/operator\/artists\/([0-9a-f-]{36})\/gmail\/inbox\/?$/i.exec(url.pathname);
  if (!match) return null;
  const origin = request.headers.get('origin');
  if (origin && origin !== CRM_ORIGIN) return json(request, 403, { error: 'origin_denied' });
  if (request.method === 'OPTIONS') {
    if (origin !== CRM_ORIGIN) return json(request, 403, { error: 'origin_denied' });
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': CRM_ORIGIN,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
      vary: 'Origin',
    } });
  }
  if (request.method !== 'GET') return json(request, 405, { error: 'method_not_allowed' });
  const token = bearer(request);
  const artistId = uuid(match[1]);
  if (!token) return json(request, 401, { error: 'authentication_required' });
  if (!artistId) return json(request, 400, { error: 'invalid_artist_id' });
  try {
    const snapshot = new URL('/rest/v1/gmail_client_metadata_snapshots', projectOrigin(env));
    snapshot.searchParams.set('select', 'client_id,subject,last_message_at,direction,refreshed_at,clients(full_name)');
    snapshot.searchParams.set('artist_id', `eq.${artistId}`);
    snapshot.searchParams.set('order', 'last_message_at.desc.nullslast');
    snapshot.searchParams.set('limit', '500');
    const rows = await supabaseJson(snapshot, {
      method: 'GET',
      headers: {
        apikey: publishableKey(env),
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    }, fetchImpl);
    return json(request, 200, {
      artist_id: artistId,
      clients: (Array.isArray(rows) ? rows : []).map((row) => ({
        client_id: row.client_id,
        client_name: typeof row.clients?.full_name === 'string' ? row.clients.full_name : null,
        subject: typeof row.subject === 'string' ? row.subject : '(no subject)',
        last_message_at: typeof row.last_message_at === 'string' ? row.last_message_at : null,
        direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
        untrusted_content: true,
      })),
      untrusted_content: true,
    });
  } catch (error) {
    const status = Number(error?.status);
    if (status === 401) return json(request, 401, { error: 'authentication_required' });
    if (status === 403) return json(request, 403, { error: 'artist_scope_denied' });
    return json(request, 503, { error: 'gmail_metadata_snapshot_unavailable' });
  }
}

export const __testing = Object.freeze({
  METADATA_CONCURRENCY,
  PROVIDER_TIMEOUT_MS,
  SNAPSHOT_WINDOW_DAYS,
  metadataCorrespondent,
  latestKnownRows,
});
