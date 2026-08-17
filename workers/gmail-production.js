import {
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
} from './lib/google-gmail.js';
import { createGmailSupabase } from './lib/gmail-supabase.js';

const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const REDIRECT_URI = 'https://gmail.vishartattoo.com/oauth/google/callback';
const STATE_PREFIX = 'gmail:state:';
const STATE_TTL_SECONDS = 600;
const MAX_BODY_BYTES = 16 * 1024;
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});
const HTML_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
});
const ARTISTS = Object.freeze({
  vladimir: Object.freeze({
    artistId: 'a1111111-1111-4111-8111-111111111111',
    integrationKey: 'google_gmail_vladimir',
    expectedEmail: 'vvetrov41@gmail.com',
    enabledFlag: 'GMAIL_VLADIMIR_ENABLED',
  }),
  kristina: Object.freeze({
    artistId: 'a2222222-2222-4222-8222-222222222222',
    integrationKey: 'google_gmail_kristina',
    expectedEmail: 'tinaakaten@gmail.com',
    enabledFlag: 'GMAIL_KRISTINA_ENABLED',
  }),
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function html(status, title, message) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.55}h1{font-size:1.6rem}</style></head><body><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
  return new Response(body, { status, headers: HTML_HEADERS });
}

function configured(env) {
  return env?.VISHAR_ENVIRONMENT === 'production'
    && env?.SUPABASE_URL === PRODUCTION_SUPABASE_ORIGIN
    && env?.GOOGLE_OAUTH_REDIRECT_URI === REDIRECT_URI
    && typeof env?.GOOGLE_OAUTH_CLIENT_ID === 'string'
    && env.GOOGLE_OAUTH_CLIENT_ID.length >= 16
    && typeof env?.GOOGLE_OAUTH_CLIENT_SECRET === 'string'
    && env.GOOGLE_OAUTH_CLIENT_SECRET.length >= 16
    && typeof env?.SUPABASE_SECRET_KEY === 'string'
    && env.SUPABASE_SECRET_KEY.startsWith('sb_secret_')
    && typeof env?.SUPABASE_PUBLISHABLE_KEY === 'string'
    && env.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')
    && env?.GMAIL_OAUTH_STATE
    && env?.GMAIL_OAUTH_TOKENS;
}

function artistConfig(slug, env) {
  const config = ARTISTS[slug];
  if (!config || env?.[config.enabledFlag] !== 'true') return null;
  return config;
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,8192})$/.exec(request.headers.get('authorization') || '');
  return match?.[1] || null;
}

function randomB64url(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256B64url(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stateKey(state) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) throw new Error('gmail_oauth_state_invalid');
  return `${STATE_PREFIX}${state}`;
}

async function startOAuth(url, env) {
  if (env?.GMAIL_OAUTH_ENABLED !== 'true') return json(404, { error: 'not_found' });
  const match = /^\/oauth\/google\/start\/(vladimir|kristina)\/?$/.exec(url.pathname);
  if (!match) return null;
  const config = artistConfig(match[1], env);
  if (!config) return json(404, { error: 'not_found' });

  const state = randomB64url(32);
  const verifier = randomB64url(48);
  const challenge = await sha256B64url(verifier);
  await env.GMAIL_OAUTH_STATE.put(stateKey(state), JSON.stringify({
    v: 1,
    artist_id: config.artistId,
    integration_key: config.integrationKey,
    expected_email: config.expectedEmail,
    verifier,
    created_at: Date.now(),
  }), { expirationTtl: STATE_TTL_SECONDS });

  return new Response(null, {
    status: 302,
    headers: {
      ...JSON_HEADERS,
      location: authorizationUrl({
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        redirectUri: REDIRECT_URI,
        state,
        codeChallenge: challenge,
        loginHint: config.expectedEmail,
      }),
    },
  });
}

async function oauthCallback(url, env, fetchImpl) {
  if (url.pathname.replace(/\/+$/, '') !== '/oauth/google/callback') return null;
  if (env?.GMAIL_OAUTH_ENABLED !== 'true') return html(404, 'Gmail connection unavailable', 'The production Gmail OAuth connector is disabled.');
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state) || !code || code.length > 4096) {
    return html(400, 'Gmail connection failed', 'The OAuth callback was invalid. Start the Gmail connection again.');
  }

  const key = stateKey(state);
  const raw = await env.GMAIL_OAUTH_STATE.get(key);
  await env.GMAIL_OAUTH_STATE.delete(key);
  if (!raw) return html(400, 'Gmail connection failed', 'The OAuth state expired or was already used. Start the Gmail connection again.');

  let pending;
  try { pending = JSON.parse(raw); } catch { pending = null; }
  const config = Object.values(ARTISTS).find((item) => item.artistId === pending?.artist_id && item.integrationKey === pending?.integration_key);
  if (!pending || pending.v !== 1 || !config || env?.[config.enabledFlag] !== 'true' || config.expectedEmail !== pending.expected_email) {
    return html(400, 'Gmail connection failed', 'The artist binding was invalid.');
  }
  if (!Number.isFinite(pending.created_at) || Date.now() - pending.created_at > STATE_TTL_SECONDS * 1000 || typeof pending.verifier !== 'string') {
    return html(400, 'Gmail connection failed', 'The OAuth state expired. Start the Gmail connection again.');
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      code,
      verifier: pending.verifier,
      fetchImpl,
    });
    const profile = await getProfile(tokens.access_token, fetchImpl);
    if (profile.emailAddress !== config.expectedEmail) {
      return html(403, 'Wrong Google account', 'This Gmail connector is bound to a different artist mailbox. Sign in with the expected production Google account.');
    }

    const db = createGmailSupabase(env, fetchImpl);
    await storeRefreshToken(env, {
      artist_id: config.artistId,
      integration_key: config.integrationKey,
      mailbox_email: profile.emailAddress,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
      connected_at: new Date().toISOString(),
    });
    try {
      await db.backendRpc('service_set_gmail_integration', {
        p_artist_id: config.artistId,
        p_integration_key: config.integrationKey,
        p_mailbox_email: profile.emailAddress,
        p_scopes: String(tokens.scope || '').split(/\s+/).filter(Boolean),
      });
    } catch (error) {
      await deleteRefreshToken(env, config.artistId);
      throw error;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'gmail_oauth_failed';
    const message = reason === 'gmail_oauth_scope_mismatch'
      ? 'Google did not grant the required read and send Gmail scopes.'
      : 'The Gmail OAuth exchange or account verification failed. No Gmail integration was enabled.';
    return html(400, 'Gmail connection failed', message);
  }

  return html(200, 'Gmail connected', 'The production Gmail account identity, scopes and token usability were verified. You can return to Vishar CRM.');
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

async function readJson(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new Error('unsupported_media_type');
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('body_too_large');
  const parsed = JSON.parse(text || '{}');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid_json');
  return parsed;
}

async function authorizeEnquiry(db, token, enquiryId) {
  const auth = firstRow(await db.userRpc('gpt_authorize_gmail_enquiry', { p_enquiry_id: enquiryId }, token));
  if (!auth || !uuid(auth.artist_id) || auth.enquiry_id !== enquiryId || !uuid(auth.client_id)) throw new Error('gmail_artist_scope_invalid');
  return auth;
}

async function resolveTarget(db, auth) {
  const target = firstRow(await db.backendRpc('service_resolve_gmail_target', {
    p_artist_id: auth.artist_id,
    p_enquiry_id: auth.enquiry_id,
    p_client_id: auth.client_id,
  }));
  if (!target || target.artist_id !== auth.artist_id || target.enquiry_id !== auth.enquiry_id || target.client_id !== auth.client_id) {
    throw new Error('gmail_target_scope_invalid');
  }
  return target;
}

async function accessForTarget(env, db, target, fetchImpl) {
  try {
    const { accessToken, stored } = await refreshAccessToken(env, target.artist_id, fetchImpl);
    if (stored.integration_key !== target.integration_key || stored.mailbox_email !== target.mailbox_email) throw new Error('gmail_token_binding_mismatch');
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

function publicMessage(message) {
  return {
    provider_message_id: message.provider_message_id,
    from: message.from,
    to: message.to,
    subject: message.subject,
    timestamp: message.timestamp,
    body: message.body,
    direction: message.direction,
    untrusted_content: true,
  };
}

async function handleGptAction(request, url, env, fetchImpl) {
  const history = /^\/v1\/enquiries\/([0-9a-f-]{36})\/gmail\/history\/?$/i.exec(url.pathname);
  const thread = /^\/v1\/enquiries\/([0-9a-f-]{36})\/gmail\/threads\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
  const reply = /^\/v1\/enquiries\/([0-9a-f-]{36})\/gmail\/reply-drafts\/?$/i.exec(url.pathname);
  if (!history && !thread && !reply) return null;
  if (env?.GMAIL_READ_ENABLED !== 'true') return json(404, { error: 'not_found' });

  const token = bearer(request);
  if (!token) return json(401, { error: 'oauth_token_required' });
  const enquiryId = uuid((history || thread || reply)?.[1]);
  if (!enquiryId) return json(400, { error: 'invalid_enquiry_id' });

  try {
    const db = createGmailSupabase(env, fetchImpl);
    const auth = await authorizeEnquiry(db, token, enquiryId);
    const target = await resolveTarget(db, auth);
    const accessToken = await accessForTarget(env, db, target, fetchImpl);

    if (history) {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
      for (const key of url.searchParams.keys()) if (!['thread_limit', 'message_limit'].includes(key)) return json(400, { error: 'unexpected_field', field: key });
      const threadLimit = Number(url.searchParams.get('thread_limit') || 4);
      const messageLimit = Number(url.searchParams.get('message_limit') || 20);
      if (!Number.isInteger(threadLimit) || threadLimit < 1 || threadLimit > 8 || !Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 30) {
        return json(400, { error: 'invalid_limit' });
      }
      const found = await searchThreads(accessToken, {
        mailboxEmail: target.mailbox_email,
        clientEmail: target.client_email,
        threadLimit,
        messageLimit,
        fetchImpl,
      });
      const threads = [];
      for (const item of found) {
        const last = item.messages.at(-1);
        const contextId = await db.backendRpc('service_upsert_gmail_thread_context', {
          p_artist_id: auth.artist_id,
          p_enquiry_id: auth.enquiry_id,
          p_client_id: auth.client_id,
          p_provider_thread_id: item.providerThreadId,
          p_subject: last?.subject || '(no subject)',
          p_last_provider_message_id: last?.provider_message_id || null,
          p_last_rfc822_message_id: last?._rfc822_message_id || null,
        });
        threads.push({
          thread_context_id: contextId,
          subject: last?.subject || '(no subject)',
          message_count: item.messages.length,
          messages: item.messages.map(publicMessage),
          untrusted_content: true,
        });
      }
      return json(200, { enquiry_id: enquiryId, threads, untrusted_content: true });
    }

    if (thread) {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
      if ([...url.searchParams.keys()].length) return json(400, { error: 'unexpected_query' });
      const contextId = uuid(thread[2]);
      if (!contextId) return json(400, { error: 'invalid_thread_context_id' });
      const context = firstRow(await db.backendRpc('service_get_gmail_thread_context', {
        p_thread_context_id: contextId,
        p_artist_id: auth.artist_id,
        p_enquiry_id: auth.enquiry_id,
        p_client_id: auth.client_id,
      }));
      const found = await getThread(accessToken, context.provider_thread_id, {
        mailboxEmail: target.mailbox_email,
        clientEmail: target.client_email,
        messageLimit: 30,
        fetchImpl,
      });
      return json(200, {
        enquiry_id: enquiryId,
        thread_context_id: contextId,
        subject: found.messages.at(-1)?.subject || context.subject,
        messages: found.messages.map(publicMessage),
        untrusted_content: true,
      });
    }

    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const body = await readJson(request);
    const allowed = new Set(['thread_context_id', 'body']);
    for (const key of Object.keys(body)) if (!allowed.has(key)) return json(400, { error: 'unexpected_field', field: key });
    const contextId = uuid(body.thread_context_id);
    if (!contextId || typeof body.body !== 'string' || !body.body.trim() || body.body.length > 8000) return json(400, { error: 'invalid_reply_draft' });

    const context = firstRow(await db.backendRpc('service_get_gmail_thread_context', {
      p_thread_context_id: contextId,
      p_artist_id: auth.artist_id,
      p_enquiry_id: auth.enquiry_id,
      p_client_id: auth.client_id,
    }));
    const live = await getThread(accessToken, context.provider_thread_id, {
      mailboxEmail: target.mailbox_email,
      clientEmail: target.client_email,
      messageLimit: 30,
      fetchImpl,
    });
    if (!live.messages.length || live.messages.at(-1).subject !== context.subject) throw new Error('gmail_thread_subject_changed');

    const result = await db.userRpc('gpt_create_gmail_reply_draft', {
      p_enquiry_id: enquiryId,
      p_thread_context_id: contextId,
      p_body: body.body,
    }, token);
    return json(200, firstRow(result) || result || {});
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'gmail_action_failed';
    if (reason === 'gmail_rpc_forbidden' || reason.includes('scope')) return json(403, { error: 'artist_scope_denied' });
    if (reason === 'body_too_large') return json(413, { error: reason });
    if (reason === 'unsupported_media_type') return json(415, { error: reason });
    if (reason === 'invalid_json') return json(400, { error: reason });
    if (reason === 'gmail_refresh_token_missing' || reason === 'gmail_refresh_token_revoked') return json(409, { error: 'gmail_reconnect_required' });
    if (reason === 'gmail_thread_outside_client_scope' || reason === 'gmail_target_scope_invalid' || reason === 'gmail_token_binding_mismatch') {
      return json(403, { error: 'artist_scope_denied' });
    }
    return json(502, { error: 'gmail_provider_unavailable' });
  }
}

function safeErrorCode(error) {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : 'gmail_provider_error';
}

function workerId() {
  return `gmail-worker-${randomB64url(12).toLowerCase()}`.replace(/[^a-z0-9_-]/g, '').slice(0, 100);
}

async function processEmailJob(job, env, db, id, fetchImpl) {
  if (!job?.outbox_id || !uuid(job.artist_id) || !uuid(job.email_message_id) || !uuid(job.client_id) || !uuid(job.enquiry_id) || job.job_valid !== true) {
    throw new Error('gmail_email_job_invalid');
  }
  const auth = { artist_id: job.artist_id, enquiry_id: job.enquiry_id, client_id: job.client_id };
  const target = await resolveTarget(db, auth);
  if (target.integration_key !== job.integration_key || target.mailbox_email !== job.mailbox_email || target.client_email !== String(job.to_email || '').trim().toLowerCase()) {
    throw new Error('gmail_email_route_changed');
  }
  const accessToken = await accessForTarget(env, db, target, fetchImpl);

  let providerThreadId = null;
  let inReplyTo = null;
  let references = null;
  let context = null;
  if (job.thread_context_id) {
    context = firstRow(await db.backendRpc('service_get_gmail_thread_context', {
      p_thread_context_id: job.thread_context_id,
      p_artist_id: auth.artist_id,
      p_enquiry_id: auth.enquiry_id,
      p_client_id: auth.client_id,
    }));
    if (context.subject !== job.subject) throw new Error('gmail_thread_subject_mismatch');
    const live = await getThread(accessToken, context.provider_thread_id, {
      mailboxEmail: target.mailbox_email,
      clientEmail: target.client_email,
      messageLimit: 30,
      fetchImpl,
    });
    const latest = live.messages.at(-1);
    if (!latest?._rfc822_message_id || latest.subject !== job.subject) throw new Error('gmail_thread_reply_context_invalid');
    providerThreadId = context.provider_thread_id;
    inReplyTo = latest._rfc822_message_id;
    references = [latest._references, latest._rfc822_message_id].filter(Boolean).join(' ').trim();
  }

  const sent = await sendMessage(accessToken, {
    toEmail: target.client_email,
    subject: job.subject,
    body: job.body,
    emailMessageId: job.email_message_id,
    threadId: providerThreadId,
    inReplyTo,
    references,
    fetchImpl,
  });

  if (context) {
    await db.backendRpc('service_upsert_gmail_thread_context', {
      p_artist_id: auth.artist_id,
      p_enquiry_id: auth.enquiry_id,
      p_client_id: auth.client_id,
      p_provider_thread_id: sent.providerThreadId || context.provider_thread_id,
      p_subject: job.subject,
      p_last_provider_message_id: sent.providerMessageId,
      p_last_rfc822_message_id: sent.rfc822MessageId,
    });
  }

  await db.backendRpc('record_email_outbox_result', {
    p_outbox_id: job.outbox_id,
    p_worker_id: id,
    p_succeeded: true,
    p_provider_message_id: sent.providerMessageId,
    p_error_code: null,
  });
  return { outbox_id: job.outbox_id, outcome: sent.deduplicated ? 'deduplicated' : 'sent' };
}

export async function drainEmailOutbox(env, { fetchImpl = fetch, limit = 10, leaseSeconds = 120, id = workerId() } = {}) {
  if (env?.GMAIL_DRAIN_ENABLED !== 'true') return { skipped: true, processed: 0, results: [] };
  const db = createGmailSupabase(env, fetchImpl);
  const claimed = await db.backendRpc('claim_email_outbox', {
    p_worker_id: id,
    p_limit: Math.max(1, Math.min(Number(limit) || 10, 20)),
    p_lease_seconds: Math.max(30, Math.min(Number(leaseSeconds) || 120, 600)),
  });
  const results = [];
  for (const job of Array.isArray(claimed) ? claimed : []) {
    try {
      results.push(await processEmailJob(job, env, db, id, fetchImpl));
    } catch (error) {
      const errorCode = safeErrorCode(error);
      if (job?.outbox_id) {
        try {
          await db.backendRpc('record_email_outbox_result', {
            p_outbox_id: job.outbox_id,
            p_worker_id: id,
            p_succeeded: false,
            p_provider_message_id: null,
            p_error_code: errorCode,
          });
        } catch {
          // The original provider error remains authoritative. Never log payloads or credentials here.
        }
      }
      results.push({ outbox_id: job?.outbox_id || null, outcome: 'failed', error_code: errorCode });
    }
  }
  return { skipped: false, processed: results.length, results };
}

async function enforceRateLimit(request, env, route) {
  const limiter = env?.GMAIL_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await limiter.limit({ key: `${route}:${address}` });
  return result.success ? null : json(429, { error: 'rate_limited' });
}

export default {
  async fetch(request, env) {
    if (!configured(env)) return json(404, { error: 'not_found' });
    const url = new URL(request.url);
    const route = url.pathname.startsWith('/oauth/') ? 'oauth' : url.pathname.includes('/gmail/') ? 'gmail_action' : 'other';
    const limited = await enforceRateLimit(request, env, route);
    if (limited) return limited;

    if (request.method === 'GET') {
      const start = await startOAuth(url, env);
      if (start) return start;
      const callback = await oauthCallback(url, env, fetch);
      if (callback) return callback;
    }
    const action = await handleGptAction(request, url, env, fetch);
    if (action) return action;
    return json(404, { error: 'not_found' });
  },
  async scheduled(_controller, env, ctx) {
    if (env?.GMAIL_DRAIN_ENABLED !== 'true') return;
    ctx.waitUntil(drainEmailOutbox(env));
  },
};

export const __testing = Object.freeze({
  configured,
  artistConfig,
  bearer,
  stateKey,
  startOAuth,
  oauthCallback,
  handleGptAction,
  authorizeEnquiry,
  resolveTarget,
  accessForTarget,
  publicMessage,
  safeErrorCode,
  processEmailJob,
});
