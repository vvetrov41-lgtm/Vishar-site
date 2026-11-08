// Independent, strictly recipient-bound emergency booking recovery.
// This module does not query Supabase or expose an HTTP endpoint.
import { refreshAccessToken, getProfile, sendMessage } from './google-gmail.js';

const SENDER_ARTIST = 'a1111111-1111-4111-8111-111111111111';
const SENDER_MAILBOX = 'vvetrov41@gmail.com';
const RECIPIENTS = Object.freeze({
  kristina: { origin: 'https://www.kristinavishar.com', to: 'bookings@kristinavishar.com' },
  vladimir: { origin: 'https://vishartattoo.com', to: 'vvetrov41@gmail.com' },
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TECHNICAL_FAILURES = new Set([
  'enquiry_rejected', 'database_unavailable', 'intake_incomplete',
  'storage_upload_failed', 'intake_finalisation_failed',
]);
const clean = (value, max) => typeof value === 'string'
  ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max)
  : '';

export function formatFailedBooking(value) {
  if (!value || typeof value !== 'object' || !RECIPIENTS[value.artist]
    || RECIPIENTS[value.artist].origin !== value.origin
    || !UUID.test(value.idempotencyKey || '')
    || !TECHNICAL_FAILURES.has(value.failureCode)
    || value.privacyAcknowledged !== true
    || !/^2026-\d{2}-\d{2}$/.test(value.privacyNoticeVersion || '')
    || !clean(value.name, 160) || !clean(value.idea, 4500)
    || !['Email', 'WhatsApp', 'Instagram'].includes(value.preferredReply)
    || (!clean(value.email, 254) && !clean(value.phone, 50))
    || typeof value.idea !== 'string' || value.idea.length > 4500
    || typeof value.name !== 'string' || value.name.length > 160
    || typeof value.email !== 'string' || value.email.length > 254
    || typeof value.phone !== 'string' || value.phone.length > 50
  ) throw new Error('booking_fallback_payload_invalid');

  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  if (attachments.length > 3 || attachments.some(a =>
    !a || !(a.bytes instanceof Uint8Array)
    || !['image/jpeg','image/png','image/webp'].includes(a.mimeType)
    || a.bytes.byteLength < 1 || a.bytes.byteLength > 4*1024*1024
    || typeof a.name !== 'string' || a.name.length > 128)
    || attachments.reduce((n,a)=>n+a.bytes.byteLength,0)>8*1024*1024)
    throw new Error('booking_fallback_attachments_invalid');
  const files = Array.isArray(value.files) ? value.files : [];
  if (files.length > 6 || files.some(f =>
    typeof f?.name !== 'string' || f.name.length > 128
    || !Number.isInteger(f.size) || f.size < 0 || f.size > 10 * 1024 * 1024))
    throw new Error('booking_fallback_file_metadata_invalid');

  const lines = [
    'BOOKING FAILED - MANUAL REVIEW',
    'This enquiry was NOT confirmed as saved in Vishar CRM.',
    'Before entering it manually, check CRM for this idempotency key:',
    value.idempotencyKey,
    '',
    'Artist: ' + value.artist,
    'Failure: ' + value.failureCode,
    'Client: ' + clean(value.name, 160),
    'Email: ' + (clean(value.email, 254) || '(not supplied)'),
    'Phone: ' + (clean(value.phone, 50) || '(not supplied)'),
    'Preferred reply: ' + value.preferredReply,
    'Idea: ' + clean(value.idea, 4500),
    'Placement: ' + clean(value.placement, 220),
    'Size: ' + clean(value.size, 140),
    'Style: ' + clean(value.projectType, 220),
    'Cover-up: ' + clean(value.coverUp, 110),
    'Timing: ' + clean(value.timing, 200),
    'Discovery: ' + clean(value.discoverySource, 100) + ' ' + clean(value.discoverySourceDetail, 200),
    'Privacy accepted: yes, notice ' + value.privacyNoticeVersion,
    'Reference files: ' + (files.length || 'none'),
    ...files.map((f, index) => (index + 1) + '. ' + clean(f.name, 128) + ' (' + f.size + ' bytes)'),
    attachments.length===files.length
      ? 'All validated reference images are attached.'
      : 'Only ' + attachments.length + ' of ' + files.length +
        ' images attached (email size cap). Request missing originals from the client.',
    '',
    'Sent by the independent Gmail failover when durable CRM intake failed.',
  ];
  return {
    toEmail: RECIPIENTS[value.artist].to,
    subject: 'Booking failed - manual review - ' + value.artist + ' - ' + value.idempotencyKey.slice(0, 8),
    body: lines.join('\n').slice(0, 7900),
    emailMessageId: value.idempotencyKey,
    attachments,
  };
}

export async function deliverFailedBookingMail(env, value, {
  fetchImpl = fetch, refresh = refreshAccessToken, profile = getProfile, send = sendMessage,
} = {}) {
  const email = formatFailedBooking(value);
  if (env?.VISHAR_ENVIRONMENT !== 'production'
    || env?.GMAIL_VLADIMIR_ENABLED !== 'true' || !env?.GMAIL_OAUTH_TOKENS)
    throw new Error('booking_fallback_disabled');
  // A bounded artist-wide throttle complements intake's public per-IP rate cap.
  if (env.GMAIL_RATE_LIMIT?.limit) {
    const limited = await env.GMAIL_RATE_LIMIT.limit({ key: 'fallback:' + value.artist });
    if (!limited.success) throw new Error('booking_fallback_rate_limited');
  }
  const { accessToken, stored } = await refresh(env, SENDER_ARTIST, fetchImpl);
  if (stored.integration_key !== 'google_gmail_vladimir'
    || stored.mailbox_email !== SENDER_MAILBOX
    || (await profile(accessToken, fetchImpl)).emailAddress !== SENDER_MAILBOX)
    throw new Error('booking_fallback_mailbox_mismatch');
  // sendMessage searches Gmail by deterministic RFC822 Message-ID first.
  // A replay with the same client-generated idempotency UUID cannot send again
  // once Gmail has indexed the first delivery.
  const receiptKey = 'booking-fallback:delivered:' + value.artist + ':' + value.idempotencyKey;
  const store = env.GMAIL_OAUTH_STATE;
  if (store?.get && await store.get(receiptKey)==='sent')
    return {accepted:true,deduplicated:true};
  const delivered = await send(accessToken, { ...email, fetchImpl });
  if (delivered.providerMessageId && store?.put) {
    try { await store.put(receiptKey, 'sent', {expirationTtl:7*24*60*60}); }
    catch { /* Gmail acceptance remains authoritative; replay searches its Message-ID */ }
  }
  return { accepted: Boolean(delivered.providerMessageId), deduplicated: delivered.deduplicated === true };
}
