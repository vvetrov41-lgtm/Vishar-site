import assert from 'node:assert/strict';
import { drainWhatsappTemplateSmokeTest } from '../workers/lib/whatsapp-template-smoke.js';

const testId = '84a5952a-571c-4a00-820f-d224129a1084';
const artistId = 'a1111111-1111-4111-8111-111111111111';
const source = {
  test_id: testId, artist_id: artistId,
  integration_key: 'vladimir-production', contact_wa_id: '447700900123',
  purpose: 'consultation_reminder',
  template_name: 'vishar_lifecycle_consultation_v1', template_language: 'en_GB',
  body_parameters: [
    'Kristina', 'Vladimir', 'TEST ONLY, no consultation booked',
    'Label Tattoo Kensington | Google Maps: https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic',
    'https://vishartattoo.com/',
  ],
};
{
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name) {
      assert.equal(name, 'service_claim_whatsapp_template_smoke_test');
      return [];
    } },
    async send() { throw new Error('no job must not send'); },
  });
  assert.deepEqual(result, { claimed: 0, accepted: 0, failed: 0, unrecorded: 0 });
}
{
  let calls = 0;
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name, payload) {
      if (name === 'service_claim_whatsapp_template_smoke_test') return [source];
      assert.equal(name,'service_record_whatsapp_template_smoke_result');
      assert.deepEqual(payload, {
        p_test_id: testId, p_accepted: true,
        p_provider_message_id: 'wamid.fixture', p_error_code: null,
      });
      return true;
    }},
    async send(env, route, message) {
      calls++;
      assert.equal(route.integration_key,'vladimir-production');
      assert.equal(route.provider,'meta_cloud_api');
      assert.equal(message.templateName,'vishar_lifecycle_consultation_v1');
      assert.equal(message.language,'en_GB');
      assert.equal(message.to,'447700900123');
      assert.deepEqual(message.bodyParameters,source.body_parameters);
      return { delivered: true, providerMessageId:'wamid.fixture' };
    },
  });
  assert.equal(calls,1);
  assert.deepEqual(result, { claimed:1, accepted:1, failed:0, unrecorded:0 });
}
{
  let sendCalled=false;
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name, payload) {
      if (name === 'service_claim_whatsapp_template_smoke_test') {
        return [{ ...source, body_parameters:[...source.body_parameters.slice(0,3),'Line 1\nLine 2','https://vishartattoo.com/'] }];
      }
      assert.equal(payload.p_error_code,'whatsapp_smoke_payload_invalid');
      assert.equal(payload.p_accepted,false);
      return true;
    }},
    async send() { sendCalled=true; },
  });
  assert.equal(sendCalled,false);
  assert.equal(result.failed,1);
}
{
  const result=await drainWhatsappTemplateSmokeTest({},{
    supabase:{async rpc(name,payload){
      if(name==='service_claim_whatsapp_template_smoke_test')return[source];
      assert.equal(payload.p_accepted,false);
      assert.equal(payload.p_error_code,'whatsapp_rejected');
      return true;
    }},
    async send(){return{delivered:false,errorCode:'whatsapp_rejected'};},
  });
  assert.equal(result.failed,1);
}
{
  const result=await drainWhatsappTemplateSmokeTest({},{
    supabase:{async rpc(name){
      if(name==='service_claim_whatsapp_template_smoke_test')return[source];
      throw new Error('network ack lost');
    }},
    async send(){return{delivered:true,providerMessageId:'wamid.fixture'};},
  });
  assert.equal(result.unrecorded,1,'unknown send never retries');
}
{
  // A newly Meta-approved v2 consultation template can be smoke-tested once,
  // without creating a fake appointment or falling back to body-only v1.
  let sends = 0;
  const v2 = { ...source, template_name: 'vishar_lifecycle_consultation_v2' };
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name, payload) {
      if (name === 'service_claim_whatsapp_template_smoke_test') return [v2];
      assert.equal(payload.p_accepted, true);
      assert.equal(payload.p_provider_message_id, 'wamid.v2fixture');
      return true;
    } },
    async send(_env, _route, message) {
      sends++;
      assert.equal(message.templateName, 'vishar_lifecycle_consultation_v2');
      assert.equal(message.purpose, 'consultation_reminder');
      assert.deepEqual(message.bodyParameters, v2.body_parameters);
      return { delivered: true, providerMessageId: 'wamid.v2fixture' };
    },
  });
  assert.equal(sends, 1);
  assert.equal(result.accepted, 1);
}
console.log('One-shot WhatsApp Meta smoke tests passed');
