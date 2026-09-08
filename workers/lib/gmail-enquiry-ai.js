const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_SOURCE_CHARS = 12000;

/**
 * A bounded side effect of an already-authorized enquiry Gmail read. This is
 * deliberately not mailbox discovery or ingestion for an unknown client.
 * auth and target come from the existing RLS/capability/provider resolvers;
 * messages come only from the normalized, mailbox/client-checked Gmail read.
 * The database independently checks this scope, feature gate and event identity.
 */
export async function enqueueGmailEnquiryAnalysis(db, auth, target, thread) {
  try {
    if (!auth || !target
      || !['artist_id', 'enquiry_id', 'client_id'].every((key) => UUID.test(auth[key] || '') && auth[key] === target[key])) {
      return { status: 'skipped' };
    }
    const message = Array.isArray(thread?.messages) ? thread.messages.at(-1) : null;
    const inbound = message?.direction === 'inbound'
      && message.from === target.client_email && message.to === target.mailbox_email;
    const outbound = message?.direction === 'outbound'
      && message.from === target.mailbox_email && message.to === target.client_email;
    if ((!inbound && !outbound) || !PROVIDER_ID.test(message.provider_message_id || '')
      || !PROVIDER_ID.test(thread?.providerThreadId || '')) return { status: 'skipped' };

    const candidate = inbound && typeof message.body === 'string' && message.body.trim()
      ? `Subject: ${String(message.subject || '').slice(0, 500)}\n\n${message.body}`.replace(/\u0000/g, '').slice(0, MAX_SOURCE_CHARS)
      : null;
    // Conservative relevance gate: this MVP does not enrich unrelated mail.
    // Short follow-ups with no tattoo context remain available in Gmail as usual.
    const sourceText = candidate && /\b(tattoo\w*|booking|enquir\w*|consultation|cover[ -]?up|sleeve|forearm|trident|neptune|poseidon)\b|тату|эскиз|рукав|перекрыти|нептун|посейдон/iu.test(candidate)
      ? candidate : null;
    const result = await db.backendRpc('service_observe_gmail_enquiry_ai', {
      p_artist_id: auth.artist_id,
      p_enquiry_id: auth.enquiry_id,
      p_client_id: auth.client_id,
      p_provider_thread_id: thread.providerThreadId,
      p_subject: message.subject || '(no subject)',
      p_last_provider_message_id: message.provider_message_id,
      p_last_rfc822_message_id: message._rfc822_message_id || null,
      p_source_text: sourceText,
    });
    return ['queued', 'existing', 'observed', 'ambiguous'].includes(result?.status)
      && UUID.test(result?.thread_context_id || '') ? result : { status: 'failed' };
  } catch {
    // AI enrichment must never turn a successful Gmail read into an error.
    // Do not emit exception text: upstream errors may contain private content.
    return { status: 'failed' };
  }
}
