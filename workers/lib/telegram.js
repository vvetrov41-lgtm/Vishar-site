// Telegram notification provider.
//
// Telegram is a NOTIFICATION, not the record. Every function here is
// best-effort: it reports what happened and never throws into the intake path.
// Losing every Telegram message loses no business data — the enquiry is already
// committed in Postgres. The outbox row records the failed side effect for the
// future drain; no automatic retry runs until that drain is deployed.
//
// The notification carries the reference number and a count, never the client's
// details. Whoever receives it opens the CRM to see the enquiry; the messaging
// app is not where personal data should accumulate.

import { statusClass } from './logging.js';

export function isTelegramConfigured(env) {
  return Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID);
}

export function buildEnquiryNotification({ referenceNumber, fileCount, clientConflict }) {
  const lines = [
    'NEW TATTOO ENQUIRY',
    '',
    `Reference: ${referenceNumber}`,
    `Reference images: ${fileCount}`,
  ];

  if (clientConflict) {
    lines.push('', 'Note: the email and phone matched two different client records. Review before replying.');
  }

  lines.push('', 'Open the CRM to see the full enquiry and images.');
  return lines.join('\n');
}

/**
 * Sends a plain notification. Returns an outcome object; never throws.
 */
export async function sendNotification(env, text, fetchImpl = fetch) {
  if (!isTelegramConfigured(env)) {
    return { delivered: false, errorCode: 'telegram_not_configured' };
  }

  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      }
    );

    if (!response.ok) {
      // Only the status class is retained. A Telegram error body can echo the
      // message that was sent.
      return { delivered: false, errorCode: 'telegram_rejected', statusClass: statusClass(response.status) };
    }

    return { delivered: true };
  } catch {
    return { delivered: false, errorCode: 'telegram_unreachable' };
  }
}
