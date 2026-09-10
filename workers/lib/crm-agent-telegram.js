// Read-only "what needs me" command for the Telegram control surface.
//
// The artist works from a phone. Push already tells them when something
// happens; this is how they ask, on their own initiative, what is still
// waiting for them.
//
// It is a read and only a read. There is deliberately no command here that
// sends a message, offers a date, requests a deposit or confirms a booking: a
// Telegram chat id is a weaker authentication factor than a signed-in CRM
// session, and it must not carry a client-facing or financial capability.
// Acting on a recommendation stays in the CRM.

import { createSupabaseClient } from './supabase.js';
import { sendSharedTelegramNotification } from './telegram.js';

const CHAT_ID = /^-?[0-9]{1,20}$/;

/** Both spellings of the same question; the artist should not have to remember one. */
const DIGEST_COMMAND = /^\/(needsme|today)(?:@[A-Za-z][A-Za-z0-9_]{4,31})?$/;

const ACTION_LABELS = Object.freeze({
  request_information: 'Ask the client for missing details',
  artist_review: 'Needs your review',
  prepare_quote: 'Prepare an estimate',
  offer_dates: 'Offer dates',
  request_deposit: 'Request a deposit',
  confirm_booking: 'Confirm the booking',
  follow_up: 'Follow up',
});

const EMPTY_MESSAGE = 'Vishar CRM: nothing is waiting for you right now.';
const UNAVAILABLE_MESSAGE = 'Vishar CRM: that list is unavailable at the moment. Try again shortly.';
// The database withholds recommendations the CRM has moved past and queues
// their replacement. Saying so is the difference between "you are free" and
// "the answer is being recalculated", which are not the same news.
const REFRESHING_NOTE = 'Some items are being recalculated after a recent change and will appear shortly.';

export function crmAgentDigestCommand(update) {
  const message = update?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const chatId = String(message?.chat?.id ?? '');
  const chatType = typeof message?.chat?.type === 'string' ? message.chat.type : '';
  if (!DIGEST_COMMAND.test(text)) return null;
  // Private chats only. A group chat is a shared destination, and one person's
  // client list is not group content.
  if (!CHAT_ID.test(chatId) || chatType !== 'private') return null;
  return { chatId };
}

/**
 * Renders the digest as plain text.
 *
 * Reasons are model-written and clients name themselves, so nothing here is
 * emitted as Telegram markup: the send path already uses no parse_mode, and
 * this keeps every value a literal. Newlines are collapsed so one long reason
 * cannot push the rest of the list off a phone screen.
 */
export function renderDigest(digest) {
  const items = Array.isArray(digest?.items) ? digest.items : [];
  const refreshing = Number.isInteger(digest?.refreshing) ? digest.refreshing : 0;
  if (!items.length) {
    return refreshing > 0 ? `${EMPTY_MESSAGE}\n\n${REFRESHING_NOTE}` : EMPTY_MESSAGE;
  }

  const lines = ['Vishar CRM: waiting for you', ''];
  for (const item of items.slice(0, 20)) {
    const name = typeof item?.client_name === 'string' ? item.client_name.slice(0, 80) : 'Client';
    const label = ACTION_LABELS[item?.action_type] ?? 'Needs your review';
    const reason = typeof item?.reason === 'string'
      ? item.reason.replace(/\s+/g, ' ').trim().slice(0, 300)
      : '';
    lines.push(`${item?.priority === 'high' ? '! ' : ''}${name} — ${label}`);
    if (reason) lines.push(`   ${reason}`);
  }
  if (refreshing > 0) lines.push('', REFRESHING_NOTE);
  lines.push('', 'These are suggestions. Nothing has been sent to any client.');
  return lines.join('\n');
}

/**
 * Answers one digest command. Returns true when a reply was sent.
 *
 * A backend failure produces a neutral message rather than an error detail: a
 * sender who is not linked must not be able to tell a missing link from a
 * database problem, and neither is the artist's business to debug from a chat.
 */
export async function handleCrmAgentDigestCommand(env, command, deps = {}) {
  if (env?.CRM_AGENT_TELEGRAM_DIGEST_ENABLED !== 'true') return false;
  if (!command?.chatId || !CHAT_ID.test(command.chatId)) return false;

  const { fetchImpl = fetch } = deps;
  let text = UNAVAILABLE_MESSAGE;
  try {
    const supabase = deps.supabase ?? createSupabaseClient(env, fetchImpl);
    const digest = await supabase.rpc('service_telegram_client_ai_digest', {
      p_chat_id: command.chatId,
      p_limit: 10,
    });
    text = renderDigest(digest);
  } catch {
    // Never log the error object: it can carry client names from a row.
    console.error('crm agent digest failed', JSON.stringify({ code: 'crm_agent_digest_unavailable' }));
  }

  try {
    await sendSharedTelegramNotification(env, command.chatId, text, fetchImpl);
    return true;
  } catch {
    return false;
  }
}

export const __testing = Object.freeze({
  ACTION_LABELS, DIGEST_COMMAND, EMPTY_MESSAGE, REFRESHING_NOTE, UNAVAILABLE_MESSAGE,
});
