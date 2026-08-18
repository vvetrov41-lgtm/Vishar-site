const GOOGLE_AUTH_ORIGIN = 'https://accounts.google.com';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const TOKEN_PREFIX = 'gmail:token:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid_base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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

function scopeSet(scope) {
  return new Set(String(scope || '').split(/\s+/).filter(Boolean));
}

function hasRequiredScopes(scope) {
  const scopes = scopeSet(scope);
  return scopes.has(GMAIL_READ_SCOPE) && scopes.has(GMAIL_SEND_SCOPE) && !scopes.has('https://mail.google.com/');
}

async function encryptionKey(secret) {
  if (typeof secret !== 'string' || secret.length < 43) throw new Error('gmail_encryption_key_unavailable');
  const raw = b64urlDecode(secret);
  if (raw.byteLength !== 32) throw new Error('gmail_encryption_key_invalid');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealToken(payload, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  ));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ciphertext)}`;
}

async function openToken(value, secret) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('gmail_token_envelope_invalid');
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('gmail_token_envelope_invalid');
  const iv = b64urlDecode(parts[1]);
  if (iv.byteLength !== 12) throw new Error('gmail_token_envelope_invalid');
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(parts[2]));
  const parsed = JSON.parse(decoder.decode(plaintext));
  if (
    !parsed
    || parsed.v !== 1
    || typeof parsed.artist_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.artist_id)
    || typeof parsed.integration_key !== 'string'
    || !/^google_gmail_[a-z0-9_-]{2,60}$/.test(parsed.integration_key)
    || !safeEmail(parsed.mailbox_email)
    || typeof parsed.refresh_token !== 'string'
    || parsed.refresh_token.length < 8
    || parsed.refresh_token.length > 8192
    || !hasRequiredScopes(parsed.scope)
  ) {
    throw new Error('gmail_token_envelope_invalid');
  }
  return parsed;
}

function tokenKey(artistId) {
  if (typeof artistId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artistId)) {
    throw new Error('gmail_artist_id_invalid');
  }
  return `${TOKEN_PREFIX}${artistId.toLowerCase()}`;
}

async function storeRefreshToken(env, tokenRecord) {
  if (!env?.GMAIL_OAUTH_TOKENS || typeof env.GMAIL_OAUTH_TOKENS.put !== 'function') throw new Error('gmail_token_store_unavailable');
  const sealed = await sealToken({ ...tokenRecord, v: 1 }, env.GMAIL_TOKEN_ENCRYPTION_KEY);
  await env.GMAIL_OAUTH_TOKENS.put(tokenKey(tokenRecord.artist_id), sealed);
}

async function deleteRefreshToken(env, artistId) {
  if (!env?.GMAIL_OAUTH_TOKENS || typeof env.GMAIL_OAUTH_TOKENS.delete !== 'function') return;
  await env.GMAIL_OAUTH_TOKENS.delete(tokenKey(artistId));
}

async function loadRefreshToken(env, artistId) {
  if (!env?.GMAIL_OAUTH_TOKENS || typeof env.GMAIL_OAUTH_TOKENS.get !== 'function') throw new Error('gmail_token_store_unavailable');
  const value = await env.GMAIL_OAUTH_TOKENS.get(tokenKey(artistId));
  if (!value) throw new Error('gmail_refresh_token_missing');
  const token = await openToken(value, env.GMAIL_TOKEN_ENCRYPTION_KEY);
  if (token.artist_id !== artistId) throw new Error('gmail_token_artist_mismatch');
  return token;
}

function authorizationUrl({ clientId, redirectUri, state, codeChallenge, loginHint }) {
  const url = new URL('/o/oauth2/v2/auth', GOOGLE_AUTH_ORIGIN);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', `openid email ${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}`);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (safeEmail(loginHint)) url.searchParams.set('login_hint', safeEmail(loginHint));
  return url.toString();
}

async function exchangeAuthorizationCode({ clientId, clientSecret, redirectUri, code, verifier, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'error',
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || typeof json.access_token !== 'string') {
    const providerError = typeof json?.error === 'string' ? json.error : '';
    const code = ({
      invalid_client: 'gmail_oauth_invalid_client',
      invalid_grant: 'gmail_oauth_invalid_grant',
      redirect_uri_mismatch: 'gmail_oauth_redirect_uri_mismatch',
      invalid_request: 'gmail_oauth_invalid_request',
      unauthorized_client: 'gmail_oauth_unauthorized_client',
      deleted_client: 'gmail_oauth_deleted_client',
      access_denied: 'gmail_oauth_access_denied',
    })[providerError] || 'gmail_oauth_code_exchange_failed';
    throw new Error(code);
  }
  if (typeof json.refresh_token !== 'string' || json.refresh_token.length < 8) throw new Error('gmail_oauth_refresh_token_missing');
  if (!hasRequiredScopes(json.scope)) throw new Error('gmail_oauth_scope_mismatch');
  return json;
}

async function refreshAccessToken(env, artistId, fetchImpl = fetch) {
  const stored = await loadRefreshToken(env, artistId);
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: stored.refresh_token,
    grant_type: 'refresh_token',
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'error',
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || typeof json.access_token !== 'string') {
    const error = new Error(json?.error === 'invalid_grant' ? 'gmail_refresh_token_revoked' : 'gmail_token_refresh_failed');
    error.providerStatus = response.status;
    throw error;
  }
  return { accessToken: json.access_token, stored };
}

async function gmailFetch(path, accessToken, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${GMAIL_API_ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    const error = new Error(response.status === 401 ? 'gmail_access_token_rejected' : 'gmail_api_error');
    error.providerStatus = response.status;
    throw error;
  }
  return json;
}

async function getProfile(accessToken, fetchImpl = fetch) {
  const profile = await gmailFetch('/gmail/v1/users/me/profile', accessToken, { fetchImpl });
  const email = safeEmail(profile.emailAddress);
  if (!email) throw new Error('gmail_profile_identity_invalid');
  return { emailAddress: email, messagesTotal: Number(profile.messagesTotal || 0), threadsTotal: Number(profile.threadsTotal || 0) };
}

function headerMap(headers) {
  const map = new Map();
  for (const header of Array.isArray(headers) ? headers : []) {
    const name = String(header?.name || '').toLowerCase();
    if (!map.has(name) && typeof header?.value === 'string') map.set(name, header.value);
  }
  return map;
}

function decodeBodyData(data) {
  if (typeof data !== 'string' || !data) return '';
  try { return decoder.decode(b64urlDecode(data)); } catch { return ''; }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findMimeBody(payload) {
  const stack = [payload].filter(Boolean);
  let html = '';
  while (stack.length) {
    const part = stack.shift();
    const mime = String(part?.mimeType || '').toLowerCase();
    const text = decodeBodyData(part?.body?.data);
    if (mime === 'text/plain' && text.trim()) return text.trim();
    if (!html && mime === 'text/html' && text.trim()) html = text;
    for (const child of Array.isArray(part?.parts) ? part.parts : []) stack.push(child);
  }
  return html ? stripHtml(html) : '';
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

function normalizeMessage(message, { mailboxEmail, clientEmail, maxBodyChars = 12000 } = {}) {
  if (!safeProviderId(message?.id)) return null;
  const headers = headerMap(message?.payload?.headers);
  const fromEmails = extractEmails(headers.get('from'));
  const toEmails = extractEmails(headers.get('to'));
  const mailbox = safeEmail(mailboxEmail);
  const client = safeEmail(clientEmail);
  if (!mailbox || !client) return null;

  let direction;
  if (fromEmails.has(client) && toEmails.has(mailbox)) direction = 'inbound';
  else if (fromEmails.has(mailbox) && toEmails.has(client)) direction = 'outbound';
  else return null;

  const body = findMimeBody(message.payload).slice(0, maxBodyChars);
  const subject = safeHeader(headers.get('subject')) || '(no subject)';
  const rfc822MessageId = safeHeader(headers.get('message-id'));
  const timestamp = Number.isFinite(Number(message.internalDate))
    ? new Date(Number(message.internalDate)).toISOString()
    : (() => {
        const parsed = Date.parse(headers.get('date') || '');
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
      })();

  return {
    provider_message_id: message.id,
    from: direction === 'inbound' ? client : mailbox,
    to: direction === 'inbound' ? mailbox : client,
    subject,
    timestamp,
    body,
    direction,
    untrusted_content: true,
    _rfc822_message_id: rfc822MessageId,
    _references: safeHeader(headers.get('references'), 4096),
    _in_reply_to: safeHeader(headers.get('in-reply-to'), 998),
  };
}

async function getThread(accessToken, providerThreadId, { mailboxEmail, clientEmail, messageLimit = 30, fetchImpl = fetch } = {}) {
  if (!safeProviderId(providerThreadId)) throw new Error('gmail_thread_id_invalid');
  const thread = await gmailFetch(`/gmail/v1/users/me/threads/${encodeURIComponent(providerThreadId)}?format=full`, accessToken, { fetchImpl });
  if (thread.id !== providerThreadId || !Array.isArray(thread.messages)) throw new Error('gmail_thread_response_invalid');
  const messages = thread.messages
    .map((message) => normalizeMessage(message, { mailboxEmail, clientEmail }))
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(Number(messageLimit) || 30, 30)));
  if (!messages.length) throw new Error('gmail_thread_outside_client_scope');
  return { providerThreadId, messages };
}

async function searchThreads(accessToken, { mailboxEmail, clientEmail, threadLimit = 4, messageLimit = 20, fetchImpl = fetch } = {}) {
  const client = safeEmail(clientEmail);
  if (!client) throw new Error('gmail_client_email_invalid');
  const limit = Math.max(1, Math.min(Number(threadLimit) || 4, 8));
  const q = `from:${client} OR to:${client}`;
  const listing = await gmailFetch(`/gmail/v1/users/me/threads?maxResults=${limit}&q=${encodeURIComponent(q)}`, accessToken, { fetchImpl });
  const ids = (Array.isArray(listing.threads) ? listing.threads : [])
    .map((thread) => safeProviderId(thread?.id))
    .filter(Boolean)
    .slice(0, limit);
  const threads = [];
  for (const id of ids) {
    try {
      threads.push(await getThread(accessToken, id, { mailboxEmail, clientEmail: client, messageLimit, fetchImpl }));
    } catch (error) {
      if (error instanceof Error && error.message === 'gmail_thread_outside_client_scope') continue;
      throw error;
    }
  }
  return threads;
}

function deterministicRfc822MessageId(emailMessageId) {
  if (typeof emailMessageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(emailMessageId)) throw new Error('email_message_id_invalid');
  return `<vishar-email-${emailMessageId.toLowerCase()}@vishartattoo.com>`;
}

async function findMessageByRfc822Id(accessToken, rfc822MessageId, fetchImpl = fetch) {
  const messageId = safeHeader(rfc822MessageId);
  if (!messageId) throw new Error('rfc822_message_id_invalid');
  const q = `rfc822msgid:${messageId}`;
  const result = await gmailFetch(`/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(q)}`, accessToken, { fetchImpl });
  const id = safeProviderId(result?.messages?.[0]?.id);
  const threadId = safeProviderId(result?.messages?.[0]?.threadId);
  return id ? { id, threadId } : null;
}

function utf8B64url(value) {
  return b64urlEncode(encoder.encode(value));
}

function buildRawMessage({ toEmail, subject, body, rfc822MessageId, inReplyTo, references }) {
  const to = safeEmail(toEmail);
  const safeSubject = safeHeader(subject);
  const messageId = safeHeader(rfc822MessageId);
  if (!to || !safeSubject || !messageId) throw new Error('gmail_send_headers_invalid');
  if (typeof body !== 'string' || !body.trim() || body.length > 8000) throw new Error('gmail_send_body_invalid');
  const lines = [
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const replyTo = safeHeader(inReplyTo);
  const refs = safeHeader(references, 4096);
  if (replyTo) lines.push(`In-Reply-To: ${replyTo}`);
  if (refs) lines.push(`References: ${refs}`);
  lines.push('', body);
  return lines.join('\r\n');
}

async function sendMessage(accessToken, {
  toEmail, subject, body, emailMessageId, threadId, inReplyTo, references, fetchImpl = fetch,
}) {
  const rfc822MessageId = deterministicRfc822MessageId(emailMessageId);
  const existing = await findMessageByRfc822Id(accessToken, rfc822MessageId, fetchImpl);
  if (existing) return { providerMessageId: existing.id, providerThreadId: existing.threadId, deduplicated: true, rfc822MessageId };

  const raw = buildRawMessage({ toEmail, subject, body, rfc822MessageId, inReplyTo, references });
  const payload = { raw: utf8B64url(raw) };
  if (threadId) {
    if (!safeProviderId(threadId)) throw new Error('gmail_thread_id_invalid');
    payload.threadId = threadId;
  }
  const sent = await gmailFetch('/gmail/v1/users/me/messages/send', accessToken, {
    method: 'POST', body: payload, fetchImpl,
  });
  if (!safeProviderId(sent.id) || !safeProviderId(sent.threadId)) throw new Error('gmail_send_response_invalid');
  return { providerMessageId: sent.id, providerThreadId: sent.threadId, deduplicated: false, rfc822MessageId };
}

export {
  GMAIL_READ_SCOPE,
  GMAIL_SEND_SCOPE,
  authorizationUrl,
  exchangeAuthorizationCode,
  storeRefreshToken,
  loadRefreshToken,
  deleteRefreshToken,
  refreshAccessToken,
  getProfile,
  searchThreads,
  getThread,
  sendMessage,
};

export const __testing = Object.freeze({
  b64urlEncode,
  b64urlDecode,
  safeEmail,
  safeProviderId,
  safeHeader,
  hasRequiredScopes,
  stripHtml,
  findMimeBody,
  extractEmails,
  normalizeMessage,
  deterministicRfc822MessageId,
  buildRawMessage,
  findMessageByRfc822Id,
  sealToken,
  openToken,
  tokenKey,
});
