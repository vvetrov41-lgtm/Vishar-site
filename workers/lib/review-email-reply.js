// Dedicated healing reply evidence. No AI, send or public endpoint.
import { getThread } from './google-gmail.js';

const ID = /^[A-Za-z0-9_-]{4,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_ID = /^<[^<>\s]+>$/;
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
const MAX_CHECKS = 2;

function validCandidate(c) {
  return UUID.test(c?.email_message_id ?? '') && ID.test(c?.provider_thread_id ?? '')
    && ID.test(c?.provider_message_id ?? '') && RFC_ID.test(c?.rfc822_message_id ?? '')
    && EMAIL.test(c?.client_email ?? '') && Number.isFinite(Date.parse(c?.healing_asked_at));
}

/** A reply must be in the exact bilateral Gmail thread and explicitly
 * reference the exact outbound healing message, not just share its subject. */
export function healingReplyInThread(thread, candidate) {
  if (!validCandidate(candidate) || thread?.providerThreadId !== candidate.provider_thread_id
    || thread._bilateral !== true || !Array.isArray(thread.messages)) return null;
  const sent = thread.messages.find(m => m.direction === 'outbound'
    && m.provider_message_id === candidate.provider_message_id
    && m._rfc822_message_id === candidate.rfc822_message_id);
  if (!sent || !Number.isFinite(Date.parse(sent.timestamp))) return null;
  const start = Math.max(Date.parse(sent.timestamp), Date.parse(candidate.healing_asked_at));
  const end = Date.parse(candidate.healing_asked_at) + 21 * 86400000;
  const matches = thread.messages.filter(m => {
    const at = Date.parse(m.timestamp);
    const refs = [m._in_reply_to, m._references].filter(Boolean).join(' ').match(/<[^<>\s]+>/g) ?? [];
    return m.direction === 'inbound' && ID.test(m.provider_message_id ?? '')
      && m.provider_message_id !== sent.provider_message_id && at > start && at <= end
      && refs.includes(candidate.rfc822_message_id);
  }).sort((a,b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  if (!matches.length) return null;
  const reply = matches[0];
  const body = String(reply.body ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n');
  const quote = body.search(/(?:^|\n)(?:On [^\n]{4,180} wrote:|From:\s[^\n]+|-----Original Message-----|>[^\n]*)/im);
  return { id: reply.provider_message_id, at: reply.timestamp,
    text: (quote < 0 ? body : body.slice(0, quote)).trim().slice(0, 1000) };
}

export async function pollReviewEmailReplies({ env, mailbox, accessToken, fetchImpl, rpc, readThread = getThread }) {
  if (env?.VISHAR_ENVIRONMENT !== 'production' || env?.GMAIL_READ_ENABLED !== 'true'
    || env?.GMAIL_DRAIN_ENABLED !== 'true') return;
  const scope = { p_artist_id: mailbox.artist_id, p_integration_key: mailbox.integration_key };
  const mailboxEmail = String(mailbox.external_account_label ?? '').trim().toLowerCase();
  if (!UUID.test(scope.p_artist_id ?? '') || !EMAIL.test(mailboxEmail) || !accessToken) return;
  const candidates = await rpc(env, 'service_list_review_email_checks', {
    ...scope, p_mailbox_email: mailboxEmail,
  }, fetchImpl);
  if (!Array.isArray(candidates) || candidates.length > MAX_CHECKS) throw new Error('review_email_candidate_scope_invalid');
  for (const c of candidates) {
    if (!validCandidate(c)) continue;
    try {
      const thread = await readThread(accessToken, c.provider_thread_id, {
        mailboxEmail, clientEmail: c.client_email, messageLimit: 30, fetchImpl,
      });
      const reply = healingReplyInThread(thread, c);
      await rpc(env, 'service_record_review_email_check', {
        ...scope, p_email_message_id: c.email_message_id, p_thread_id: c.provider_thread_id,
        p_reply_id: reply?.id ?? null, p_reply_at: reply?.at ?? null, p_reply_text: reply?.text ?? null,
      }, fetchImpl);
    } catch {
      // A single inaccessible thread must not break mailbox synchronization.
      // Record a check (never a reply) to rotate the bounded queue.
      try {
        await rpc(env, 'service_record_review_email_check', {
          ...scope, p_email_message_id: c.email_message_id, p_thread_id: c.provider_thread_id,
          p_reply_id: null, p_reply_at: null, p_reply_text: null,
        }, fetchImpl);
      } catch { /* retry in a later mailbox scan */ }
    }
  }
}
