import {
  refreshAccessToken,
  getProfile,
  listRecentCorrespondents,
  searchThreads,
} from './google-gmail.js';
import { createGmailSupabase } from './gmail-supabase.js';

const MAX_MAILBOXES = 20;
const MAX_CLIENTS_PER_MAILBOX = 20;
const MAX_URLS_PER_MESSAGE = 8;

function safeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email) && email.length <= 254 ? email : null;
}

export function extractClientHttpUrls(value, limit = MAX_URLS_PER_MESSAGE) {
  const results = [];
  const seen = new Set();
  const matches = String(value || '').match(/https?:\/\/[^\s<>"'\[\]{}]+/gi) || [];
  for (const match of matches) {
    const candidate = match.replace(/[.,;:!?\)\]}]+$/g, '');
    if (candidate.length < 8 || candidate.length > 2048 || seen.has(candidate)) continue;
    seen.add(candidate);
    results.push(candidate);
    if (results.length >= Math.max(1, Math.min(Number(limit) || MAX_URLS_PER_MESSAGE, MAX_URLS_PER_MESSAGE))) break;
  }
  return results;
}

function rows(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

async function boundMailboxAccess(env, mailbox, fetchImpl) {
  const { accessToken, stored } = await refreshAccessToken(env, mailbox.artist_id, fetchImpl);
  if (stored.integration_key !== mailbox.integration_key || stored.mailbox_email !== mailbox.mailbox_email) {
    throw new Error('gmail_token_binding_mismatch');
  }
  const profile = await getProfile(accessToken, fetchImpl);
  if (profile.emailAddress !== mailbox.mailbox_email) throw new Error('gmail_profile_binding_mismatch');
  return accessToken;
}

export async function discoverGmailClientLinks(env, { fetchImpl = fetch } = {}) {
  const db = createGmailSupabase(env, fetchImpl);
  const mailboxes = rows(await db.backendRpc('service_list_gmail_link_research_mailboxes', {}))
    .filter((mailbox) => mailbox && typeof mailbox.artist_id === 'string' && safeEmail(mailbox.mailbox_email))
    .slice(0, MAX_MAILBOXES);

  let scannedMailboxes = 0;
  let matchedClients = 0;
  let inspectedMessages = 0;
  let discoveredUrls = 0;
  let failedMailboxes = 0;

  for (const mailbox of mailboxes) {
    try {
      const accessToken = await boundMailboxAccess(env, mailbox, fetchImpl);
      const recent = await listRecentCorrespondents(accessToken, {
        mailboxEmail: mailbox.mailbox_email,
        messageLimit: 60,
        newerThanDays: 30,
        fetchImpl,
      });
      scannedMailboxes += 1;

      const inboundEmails = [];
      for (const item of recent) {
        const email = item?.direction === 'inbound' ? safeEmail(item.email) : null;
        if (email && !inboundEmails.includes(email)) inboundEmails.push(email);
        if (inboundEmails.length >= MAX_CLIENTS_PER_MAILBOX) break;
      }
      if (!inboundEmails.length) continue;

      const matches = rows(await db.backendRpc('service_match_gmail_clients', {
        p_artist_id: mailbox.artist_id,
        p_emails: inboundEmails,
      }));
      const clientByEmail = new Map();
      for (const match of matches) {
        const email = safeEmail(match?.client_email);
        if (email && typeof match?.client_id === 'string') clientByEmail.set(email, match.client_id);
      }
      matchedClients += clientByEmail.size;

      for (const [clientEmail, clientId] of clientByEmail) {
        let threads;
        try {
          threads = await searchThreads(accessToken, {
            mailboxEmail: mailbox.mailbox_email,
            clientEmail,
            threadLimit: 4,
            messageLimit: 20,
            fetchImpl,
          });
        } catch {
          continue;
        }
        for (const thread of threads) {
          for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
            if (message?.direction !== 'inbound' || typeof message.provider_message_id !== 'string') continue;
            inspectedMessages += 1;
            for (const url of extractClientHttpUrls(message.body)) {
              await db.backendRpc('service_enqueue_client_link_research', {
                p_artist_id: mailbox.artist_id,
                p_client_id: clientId,
                p_channel: 'gmail',
                p_source_message_key: message.provider_message_id,
                p_url: url,
              });
              discoveredUrls += 1;
            }
          }
        }
      }
    } catch {
      failedMailboxes += 1;
    }
  }

  return {
    scanned_mailboxes: scannedMailboxes,
    failed_mailboxes: failedMailboxes,
    matched_clients: matchedClients,
    inspected_messages: inspectedMessages,
    discovered_urls: discoveredUrls,
  };
}
