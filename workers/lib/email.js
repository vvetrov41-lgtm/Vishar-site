// Email provider interface.
//
// NO PROVIDER IS BOUND. Gmail is not connected, no OAuth flow has been
// completed, and nothing in this repository can send an email. `createEmailService`
// returns an implementation backed by the database only: it records intent and
// leaves delivery to a provider that does not exist yet.
//
// The shape is deliberate. Connecting Gmail later means writing one adapter
// that satisfies this interface — not rewriting the callers, and not revisiting
// who is allowed to send what.
//
// The rule that matters:
//
//   Automatic sending is limited to explicitly approved transactional
//   templates. Anything personalised — an estimate, a quote, offered dates, a
//   decline, a cover-up discussion — is a draft until a human approves it.
//   AI-generated content can only ever be a draft.
//
// That rule is enforced in the database, not here: `create_email_draft` always
// inserts `status = 'draft'` whatever it is asked for, a trigger refuses an
// AI-originated row in any other state, and only the owner may call
// `approve_email_draft`. This module cannot weaken it.

/**
 * Templates that may be sent without a person reading them first.
 *
 * Adding to this list is an owner decision, not a code decision: each entry is
 * a message that will reach a client with nobody checking it. Every one here is
 * a factual acknowledgement containing no offer, no price and no date.
 */
export const AUTOMATIC_TEMPLATES = Object.freeze({
  ENQUIRY_RECEIVED: 'enquiry_received',
});

/**
 * Message kinds that always require human approval. Listed explicitly so that
 * "did we decide this one?" has an answer in the code.
 */
export const HUMAN_APPROVAL_REQUIRED = Object.freeze([
  'estimate',
  'quote',
  'date_offer',
  'decline',
  'cover_up_discussion',
  'deposit_request',
  'reschedule',
]);

export function requiresHumanApproval(templateKey) {
  return !Object.values(AUTOMATIC_TEMPLATES).includes(templateKey);
}

export class EmailNotConnectedError extends Error {
  constructor(operation) {
    super(`email provider not connected (${operation})`);
    this.name = 'EmailNotConnectedError';
    this.code = 'email_provider_not_connected';
  }
}

/**
 * The provider contract. An implementation must be able to do these five
 * things and nothing more; there is no "send arbitrary message" entry point.
 *
 * @typedef {object} EmailProvider
 * @property {(message: {to: string, subject: string, body: string}) => Promise<{providerMessageId: string}>} send
 * @property {(providerMessageId: string) => Promise<{status: string}>} getStatus
 */

/**
 * @param {object} supabase  narrow Supabase client
 * @param {EmailProvider|null} provider  null until an owner connects one
 */
export function createEmailService(supabase, provider = null) {
  return {
    /** Always creates a draft. There is no argument that produces a sent message. */
    async createDraft({ toEmail, subject, body, clientId, enquiryId, projectId, origin = 'human' }) {
      return supabase.rpc('create_email_draft', {
        p_to_email: toEmail,
        p_subject: subject,
        p_body: body,
        p_client_id: clientId ?? null,
        p_enquiry_id: enquiryId ?? null,
        p_project_id: projectId ?? null,
        p_created_by_kind: origin === 'ai' ? 'ai' : 'human',
      });
    },

    /** Owner-only, enforced by the RPC. Approval enqueues; it does not send. */
    async approveDraft(emailMessageId) {
      return supabase.rpc('approve_email_draft', { p_email_message_id: emailMessageId });
    },

    /**
     * Approval already created the outbox job, so this is where a drain worker
     * would hand the message to a provider. Without one, it refuses.
     */
    async queueApproved(emailMessageId) {
      if (!provider) throw new EmailNotConnectedError('queueApproved');
      return { emailMessageId, queued: true };
    },

    /**
     * The only automatic path, and only for a template on the list above.
     */
    async sendTransactional({ templateKey, toEmail, subject, body }) {
      if (requiresHumanApproval(templateKey)) {
        throw new Error(
          `template "${templateKey}" is not on the automatic list and must be approved by a person`
        );
      }
      if (!provider) throw new EmailNotConnectedError('sendTransactional');
      return provider.send({ to: toEmail, subject, body });
    },

    async getStatus(providerMessageId) {
      if (!provider) throw new EmailNotConnectedError('getStatus');
      return provider.getStatus(providerMessageId);
    },

    isConnected() {
      return provider !== null;
    },
  };
}
