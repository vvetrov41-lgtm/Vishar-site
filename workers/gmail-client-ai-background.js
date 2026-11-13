// Private Gmail message capture for existing CRM clients. No send capability,
// no public route, no browser tokens, no legacy enquiry-AI job.
import { normalizeMessage, extractEmails } from './lib/google-gmail.js';

export const MAX_CAPTURE_CANDIDATES = 20;
export const MAX_CAPTURE_PER_RUN = 2;
const MAX_CAPTURE_BODY = 3500;
const ID = /^[A-Za-z0-9_-]{4,255}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function safeEmail(value) {
  const v = String(value || '').trim().toLowerCase();
  return v.length <= 254 && EMAIL.test(v) ? v : null;
}

function validId(value) {
  return typeof value === 'string' && ID.test(value);
}

function asHeaders(message) {
  const result = new Map();
  for (const header of Array.isArray(message?.payload?.headers) ? message.payload.headers : []) {
    const name = String(header?.name || '').toLowerCase();
    if (!result.has(name) && typeof header?.value === 'string') result.set(name, header.value);
  }
  return result;
}

function strictBilateral(message, mailboxEmail, clientEmail) {
  const h = asHeaders(message);
  const from = [...extractEmails(h.get('from'))];
  const to = [...extractEmails(h.get('to'))];
  return from.length === 1 && from[0] === clientEmail
    && to.length === 1 && to[0] === mailboxEmail
    && extractEmails(h.get('cc')).size === 0
    && extractEmails(h.get('bcc')).size === 0;
}

function freshReply(body) {
  // Do not let quoted older conversation be presented to the client AI as
  // something the customer wrote in their newest reply.
  const value = String(body || '').replace(/\u0000/g, '').replace(/\r\n/g, '\n');
  const cut = value.search(/(?:^|\n)(?:On [^\n]{4,180} wrote:|From:\s[^\n]+|-----Original Message-----|>[^\n]*)/im);
  const clipped = (cut >= 0 ? value.slice(0, cut) : value).trim();
  return clipped.slice(0, MAX_CAPTURE_BODY);
}

/**
 * Metadata is retrieved by the existing 20-message read-only scan; provider
 * ids remain private inside the Worker, never in the metadata snapshot/API.
 * Never guess between two clients with the same email.
 */
export function matchCaptureCandidates(metadata, matched) {
  const byEmail = new Map();
  const ambiguous = new Set();
  for (const row of Array.isArray(matched) ? matched : []) {
    const email = safeEmail(row?.client_email);
    if (!email || typeof row?.client_id !== 'string') continue;
    if (byEmail.has(email) && byEmail.get(email) !== row.client_id) ambiguous.add(email);
    else byEmail.set(email, row.client_id);
  }
  const seen = new Set();
  const candidates = [];
  for (const row of Array.isArray(metadata) ? metadata.slice(0, MAX_CAPTURE_CANDIDATES) : []) {
    const email = safeEmail(row?.email);
    const parsed = Date.parse(row?.timestamp || '');
    if (!email || ambiguous.has(email) || !byEmail.has(email)
      || row?.direction !== 'inbound'
      || !validId(row?.provider_message_id) || !validId(row?.provider_thread_id)
      || !Number.isFinite(parsed) || seen.has(row.provider_message_id)) continue;
    seen.add(row.provider_message_id);
    candidates.push({
      provider_message_id: row.provider_message_id,
      provider_thread_id: row.provider_thread_id,
      client_id: byEmail.get(email),
      client_email: email,
      occurred_at: new Date(parsed).toISOString(),
    });
  }
  return candidates.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
}

function checkedSelectedRow(value, candidates) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return candidates.find(row =>
    row.provider_message_id === value.provider_message_id
    && row.provider_thread_id === value.provider_thread_id
    && row.client_id === value.client_id
    && row.client_email === safeEmail(value.client_email)
    && Date.parse(row.occurred_at) === Date.parse(value.occurred_at || '')
  ) || null;
}

export async function captureKnownGmailReplies({
  env, artistId, mailboxEmail, metadata, matched, accessToken,
  fetchImpl, rpc, gmailGet,
}) {
  const result = { considered: 0, recorded: 0, existing: 0, skipped: 0, failed: 0 };
  if (env?.VISHAR_ENVIRONMENT !== 'production' || env?.GMAIL_READ_ENABLED !== 'true') return result;
  const mailbox = safeEmail(mailboxEmail);
  if (!mailbox || !accessToken) return result;

  const candidates = matchCaptureCandidates(metadata, matched);
  if (!candidates.length) return result;
  result.considered = candidates.length;

  // The DB returns only eligible post-activation, not-yet-recorded message ids.
  // An off kill switch returns [] without any Gmail full-body reads.
  const selected = await rpc(env, 'service_select_background_gmail_ai_candidates', {
    p_artist_id: artistId, p_mailbox_email: mailbox, p_candidates: candidates,
  }, fetchImpl);
  if (!Array.isArray(selected) || selected.length > MAX_CAPTURE_PER_RUN) {
    throw new Error('gmail_ai_candidate_scope_invalid');
  }
  const requested = new Set();

  // Capture oldest -> newest. If a mailbox received two replies between
  // scans, write both in chronology so the database's monotonic watermark
  // can reject old replays without discarding the second new reply.
  for (const row of [...selected].sort((a, b) =>
    Date.parse(a?.occurred_at || '') - Date.parse(b?.occurred_at || ''))) {
    const candidate = checkedSelectedRow(row, candidates);
    if (!candidate || requested.has(candidate.provider_message_id)) {
      result.failed += 1;
      continue;
    }
    requested.add(candidate.provider_message_id);
    try {
      // Gmail read-only API. A full message is fetched only after DB checks
      // artist/client scope, provider timestamp, activation and dedupe.
      const message = await gmailGet(
        '/gmail/v1/users/me/messages/' + encodeURIComponent(candidate.provider_message_id) + '?format=full',
        accessToken,
        fetchImpl,
      );
      if (message?.id !== candidate.provider_message_id
        || message?.threadId !== candidate.provider_thread_id
        || !strictBilateral(message, mailbox, candidate.client_email)) {
        result.skipped += 1;
        continue;
      }
      const normalized = normalizeMessage(message, {
        mailboxEmail: mailbox, clientEmail: candidate.client_email, maxBodyChars: 7000,
      });
      const body = freshReply(normalized?.body);
      if (!normalized || normalized.direction !== 'inbound'
        || Date.parse(normalized.timestamp || '') !== Date.parse(candidate.occurred_at)
        || !body) {
        result.skipped += 1;
        continue;
      }
      const saved = await rpc(env, 'service_record_background_gmail_ai_message', {
        p_artist_id: artistId,
        p_client_id: candidate.client_id,
        p_client_email: candidate.client_email,
        p_mailbox_email: mailbox,
        p_provider_thread_id: candidate.provider_thread_id,
        p_provider_message_id: candidate.provider_message_id,
        p_subject: normalized.subject,
        p_body: body,
        p_occurred_at: candidate.occurred_at,
      }, fetchImpl);
      if (saved?.status === 'recorded') result.recorded += 1;
      else if (saved?.status === 'existing') result.existing += 1;
      else if (['disabled','outside_capture_window','scope_unavailable','empty','older_than_recorded'].includes(saved?.status)) result.skipped += 1;
      else result.failed += 1;
    } catch {
      // A failed individual message must not break the metadata snapshot.
      // Never log provider ids, email addresses or message bodies.
      result.failed += 1;
    }
  }
  return result;
}

export const __testing = Object.freeze({ freshReply, strictBilateral, checkedSelectedRow });
