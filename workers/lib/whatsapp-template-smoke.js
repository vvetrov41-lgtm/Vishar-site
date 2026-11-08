// Owner-directed, one-shot WhatsApp Utility-template smoke tests.
// A private service-only SQL queue is the authority. Claim happens BEFORE
// the provider call; failures and ambiguous outcomes are never retried.
// Test requests never create clients, appointments or lifecycle jobs.
import { createSupabaseClient } from './supabase.js';
import { sendWhatsappUtilityTemplate } from './whatsapp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const ROUTE_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const WA_ID = /^[1-9][0-9]{5,19}$/;

export async function drainWhatsappTemplateSmokeTest(env, {
  supabase = createSupabaseClient(env),
  send = sendWhatsappUtilityTemplate,
} = {}) {
  const rows = await supabase.rpc('service_claim_whatsapp_template_smoke_test', {});
  const jobs = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
  if (jobs.length === 0) return { claimed: 0, accepted: 0, failed: 0, unrecorded: 0 };
  if (jobs.length !== 1) throw new Error('whatsapp_smoke_claim_invalid');

  const job = jobs[0];
  const valid = UUID.test(job.test_id ?? '')
    && UUID.test(job.artist_id ?? '')
    && ROUTE_KEY.test(job.integration_key ?? '')
    && WA_ID.test(job.contact_wa_id ?? '')
    && job.purpose === 'consultation_reminder'
    && ['vishar_lifecycle_consultation_v1',
      'vishar_lifecycle_consultation_v2',
      'vishar_lifecycle_consultation_v3'].includes(job.template_name)
    && job.template_language === 'en_GB'
    && Array.isArray(job.body_parameters)
    && job.body_parameters.length === 5
    && job.body_parameters.every((s) => typeof s === 'string'
      && s.length >= 1 && s.length <= 1024 && !/[\r\n\t]/.test(s))
    && (job.template_name !== 'vishar_lifecycle_consultation_v3'
      || (/^booking_action:[0-9a-f]{64}$/.test(job.body_parameters[3])
        && /^booking_action:[0-9a-f]{64}$/.test(job.body_parameters[4])
        && job.body_parameters[3] !== job.body_parameters[4]));
  if (!UUID.test(job.test_id ?? '')) throw new Error('whatsapp_smoke_id_invalid');

  let result = { delivered: false, errorCode: 'whatsapp_smoke_payload_invalid' };
  if (valid) {
    try {
      result = await send(env, {
        kind: 'whatsapp_message',
        integration_type: 'whatsapp',
        provider: 'meta_cloud_api',
        integration_key: job.integration_key,
      }, {
        to: job.contact_wa_id,
        purpose: job.purpose,
        templateName: job.template_name,
        language: job.template_language,
        bodyParameters: job.body_parameters,
      });
    } catch {
      result = { delivered: false, errorCode: 'whatsapp_test_send_failed' };
    }
  }

  try {
    const acknowledged = await supabase.rpc('service_record_whatsapp_template_smoke_result', {
      p_test_id: job.test_id,
      p_accepted: result.delivered === true,
      p_provider_message_id: result.delivered === true ? result.providerMessageId : null,
      p_error_code: result.delivered === true ? null : result.errorCode,
    });
    if (acknowledged !== true) throw new Error('smoke_ack_failed');
    return { claimed: 1, accepted: result.delivered === true ? 1 : 0,
      failed: result.delivered === true ? 0 : 1, unrecorded: 0 };
  } catch {
    // Once-claimed attempts stay non-retryable even when acknowledgement fails.
    return { claimed: 1, accepted: 0, failed: 0, unrecorded: 1 };
  }
}
