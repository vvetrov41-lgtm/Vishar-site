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
{
  // A v3 test can demonstrate the two buttons without any real client booking.
  const v3 = { ...source, template_name: 'vishar_lifecycle_consultation_v3',
    body_parameters: ['Kristina', 'TEST ONLY - no appointment',
      'Label Tattoo Kensington, London W14 8RL',
      'booking_action:' + 'c'.repeat(64), 'booking_action:' + 'd'.repeat(64)] };
  let count = 0;
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name, args) {
      if (name === 'service_claim_whatsapp_template_smoke_test') return [v3];
      assert.equal(args.p_accepted, true);
      return true;
    } },
    async send(_env, _route, m) {
      count++;
      assert.equal(m.templateName, 'vishar_lifecycle_consultation_v3');
      assert.deepEqual(m.bodyParameters, v3.body_parameters);
      return { delivered: true, providerMessageId: 'wamid.v3fixture' };
    },
  });
  assert.equal(count, 1);
  assert.equal(result.accepted, 1);
}
{
  // The live v4 consultation template has two quick replies and three body
  // variables. A smoke send has no real appointment or action tokens.
  const v4 = { ...source, template_name: 'vishar_lifecycle_consultation_v4',
    body_parameters: ['Kristina', 'TEST ONLY - no appointment',
      'TEST ONLY - Label Tattoo Private, London',
      'booking_action:' + 'e'.repeat(64),
      'booking_action:' + 'f'.repeat(64)] };
  let sent = 0;
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name, payload) {
      if (name === 'service_claim_whatsapp_template_smoke_test') return [v4];
      assert.equal(name, 'service_record_whatsapp_template_smoke_result');
      assert.equal(payload.p_accepted, true);
      assert.equal(payload.p_provider_message_id, 'wamid.v4fixture');
      return true;
    } },
    async send(_env, route, msg) {
      sent++;
      assert.equal(route.integration_key, 'vladimir-production');
      assert.equal(msg.templateName, 'vishar_lifecycle_consultation_v4');
      assert.equal(msg.purpose, 'consultation_reminder');
      assert.deepEqual(msg.bodyParameters, v4.body_parameters);
      return { delivered: true, providerMessageId: 'wamid.v4fixture' };
    },
  });
  assert.equal(sent, 1);
  assert.deepEqual(result, { claimed:1, accepted:1, failed:0, unrecorded:0 });
}
{
  // Invalid test buttons never contact Meta, even when v4 itself is approved.
  const v4 = { ...source, template_name: 'vishar_lifecycle_consultation_v4',
    body_parameters: ['Kristina', 'TEST ONLY - no appointment',
      'TEST ONLY - London', 'booking_action:' + 'e'.repeat(64),
      'booking_action:' + 'e'.repeat(64)] };
  let sent = false;
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name, payload) {
      if (name === 'service_claim_whatsapp_template_smoke_test') return [v4];
      assert.equal(name, 'service_record_whatsapp_template_smoke_result');
      assert.equal(payload.p_error_code, 'whatsapp_smoke_payload_invalid');
      return true;
    } },
    async send() { sent = true; },
  });
  assert.equal(sent, false);
  assert.equal(result.failed, 1);
}

for (const [purpose, template_name, params, expectedButtons] of [
  ['session_reminder_72h', 'vishar_lifecycle_reminder_72h_v3',
    ['Kristina', 'TEST ONLY - no session booked, Monday 16 November 2026 at 12:00',
      'booking_action:' + '1'.repeat(64), 'booking_action:' + '2'.repeat(64)], 2],
  ['session_reminder_72h', 'vishar_lifecycle_reminder_72h_v4',
    ['Kristina', 'TEST ONLY - no tattoo session booked',
      'booking_action:' + '7'.repeat(64), 'booking_action:' + '8'.repeat(64)], 2],
  ['session_reminder_24h', 'vishar_lifecycle_reminder_24h_v3',
    ['Kristina', 'TEST ONLY - no session booked, 12:00',
      'booking_action:' + '3'.repeat(64)], 1],
]) {
  // The production test uses the already-approved template's actual
  // preparation/arrival links and its Meta quick-reply structure.
  const reminder = { ...source, purpose, template_name, body_parameters: params };
  let count = 0;
  const result = await drainWhatsappTemplateSmokeTest({}, {
    supabase: { async rpc(name, payload) {
      if (name === 'service_claim_whatsapp_template_smoke_test') return [reminder];
      assert.equal(name, 'service_record_whatsapp_template_smoke_result');
      assert.equal(payload.p_accepted, true);
      return true;
    } },
    async send(_env, route, m) {
      count++;
      assert.equal(route.integration_key, 'vladimir-production');
      assert.equal(m.purpose, purpose);
      assert.equal(m.templateName, template_name);
      assert.equal(m.language, 'en_GB');
      assert.deepEqual(m.bodyParameters, params);
      assert.equal(params.length - 2, expectedButtons);
      return { delivered: true, providerMessageId: 'wamid.reminderfixture' };
    },
  });
  assert.equal(count, 1);
  assert.equal(result.accepted, 1);
}
for (const reminder of [
  { ...source, purpose:'session_reminder_72h',
    template_name:'vishar_lifecycle_reminder_72h_v3',
    body_parameters:['Kristina','TEST ONLY', 'booking_action:'+'a'.repeat(64),
      'booking_action:'+'a'.repeat(64)] },
  { ...source, purpose:'session_reminder_72h',
    template_name:'vishar_lifecycle_reminder_72h_v4',
    body_parameters:['Kristina','TEST ONLY', 'booking_action:'+'b'.repeat(64),
      'booking_action:'+'b'.repeat(64)] },
  { ...source, purpose:'session_reminder_24h',
    template_name:'vishar_lifecycle_reminder_24h_v3',
    body_parameters:['Kristina','TEST ONLY','no-button-token'] },
  { ...source, purpose:'session_reminder_24h',
    template_name:'vishar_lifecycle_reminder_72h_v3',
    body_parameters:['Kristina','TEST ONLY','booking_action:'+'a'.repeat(64)] },
]) {
  let sent=false;
  const result=await drainWhatsappTemplateSmokeTest({}, {
    supabase:{async rpc(name, payload){
      if(name==='service_claim_whatsapp_template_smoke_test') return [reminder];
      assert.equal(name,'service_record_whatsapp_template_smoke_result');
      assert.equal(payload.p_error_code,'whatsapp_smoke_payload_invalid');
      return true;
    }},
    async send(){sent=true;},
  });
  assert.equal(sent,false);
  assert.equal(result.failed,1);
}

for (const [purpose, template_name, params] of [
  ['session_reminder_24h', 'vishar_lifecycle_reminder_24h_v4',
    ['Kristina', '12:00 (TEST ONLY)', 'booking_action:'+'4'.repeat(64)]],
  ['consultation_reminder', 'vishar_lifecycle_consultation_v5',
    ['Kristina', 'Tuesday 10 November 2026 (TEST ONLY)',
      'Label Tattoo Private, London', 'booking_action:'+'5'.repeat(64)]],
  ['consultation_reminder', 'vishar_lifecycle_consultation_video_v1',
    ['Kristina', 'Tuesday 10 November 2026 (TEST ONLY)',
      'Video consultation - no studio visit', 'booking_action:'+'6'.repeat(64)]],
]) {
  const job={...source,purpose,template_name,body_parameters:params};
  let sent=0;
  const result=await drainWhatsappTemplateSmokeTest({}, {
    supabase:{async rpc(name,args){
      if(name==='service_claim_whatsapp_template_smoke_test')return [job];
      assert.equal(name,'service_record_whatsapp_template_smoke_result');
      assert.equal(args.p_accepted,true);return true;
    }},
    async send(_env,_route,m){
      sent++;
      assert.equal(m.templateName,template_name);
      assert.deepEqual(m.bodyParameters,params);
      return {delivered:true,providerMessageId:'wamid.fixture'};
    }
  });
  assert.equal(sent,1);
  assert.equal(result.accepted,1);
}
console.log('One-shot WhatsApp Meta smoke tests passed');
