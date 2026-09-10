const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_SOURCE_CHARS = 12000;

/** The client brief needs the reply, not the quoted thread history under it. */
const MAX_CLIENT_STATE_CHARS = 4000;

/**
 * Records what the client actually wrote, for the client brief.
 *
 * Deliberately NOT gated by the keyword relevance test below. That test exists
 * to stop the enquiry path drafting a reply to unrelated mail, and it is the
 * wrong question here: a message on a thread already bound to this artist,
 * client and enquiry is relevant to that client's state by construction. A
 * reply reading "yes, 19 October works, but could we change the dragon to
 * black and grey?" names no tattoo keyword and is exactly what the brief must
 * not miss.
 *
 * The body is bounded here and bounded again in the database, is stored in a
 * private schema no API role can read, and is treated as untrusted client data
 * by every consumer. A failure is swallowed for the same reason as below: an
 * authorized Gmail read must not turn into an error because a derived-state
 * feature was unavailable.
 *
 * The database owns baseline detection. This call intentionally happens before
 * service_observe_gmail_enquiry_ai, while the stored thread context still
 * contains the previous provider message id. A first read therefore establishes
 * a baseline rather than backfilling old mail into the client brief.
 */
async function recordGmailClientMessage(db, auth, thread, message) {
  try {
    const body = typeof message?.body === 'string' ? message.body : '';
    if (!body.trim()) return { status: 'skipped' };

    const timestamp = typeof message?.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN;
    await db.backendRpc('service_record_gmail_client_message', {
      p_artist_id: auth.artist_id,
      p_client_id: auth.client_id,
      p_enquiry_id: auth.enquiry_id,
      p_provider_thread_id: thread.providerThreadId,
      p_provider_message_id: message.provider_message_id,
      p_direction: message.direction,
      p_subject: typeof message.subject === 'string' ? message.subject.slice(0, 500) : null,
      p_body: body.replace(/\u0000/g, '').slice(0, MAX_CLIENT_STATE_CHARS),
      // Production Gmail normalization supplies this. A malformed/missing value
      // is sent as null so the database rejects the excerpt while the authorized
      // mailbox read itself still succeeds.
      p_occurred_at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    });
    return { status: 'recorded' };
  } catch {
    // Never emit the error: an RPC failure message can echo the argument.
    return { status: 'failed' };
  }
}

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

    // Client memory gets the message content independently of the enquiry
    // relevance gate below. The database rejects a first observation as a
    // historical baseline and stores only later provider-message changes.
    await recordGmailClientMessage(db, auth, thread, message);

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
