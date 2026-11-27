import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveGuideSender,sendGuideViaResend} from './resend.mjs';
const artist='a1111111-1111-4111-8111-111111111111';
const key='re_'+'synthetic_test_key_only';
const env={VISHAR_ENVIRONMENT:'production',LEAD_MAGNET_RESEND_API_KEY:key};
const id='10000000-0000-4000-8000-000000000001';
const message={emailMessageId:id,toEmail:'reader@example.invalid',subject:'Your guide',body:'Guide link'};
test('dedicated sender is fixed and artist bound',()=>{
 assert.equal(resolveGuideSender(env,artist).mailboxEmail,'info@vishartattoo.com');
 assert.throws(()=>resolveGuideSender(env,'a2222222-2222-4222-8222-222222222222'));
 assert.throws(()=>resolveGuideSender({...env,VISHAR_ENVIRONMENT:'staging'},artist));
 assert.throws(()=>resolveGuideSender({VISHAR_ENVIRONMENT:'production'},artist));
});
test('Resend request has pinned From, Reply-To, recipient and per-job idempotency',async()=>{
 const receipt=await sendGuideViaResend(key,{...message,from:'untrusted@example.invalid'},async(url,init)=>{
 assert.equal(url,'https://api.resend.com/emails');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
 assert.equal(init.headers.Authorization,'Bearer '+key);assert.equal(init.headers['Idempotency-Key'],'cover-up-guide/'+id);
 const body=JSON.parse(init.body);
 assert.deepEqual(body,{from:'Vladimir Vishar <info@vishartattoo.com>',to:[message.toEmail],subject:message.subject,text:message.body,reply_to:'info@vishartattoo.com'});
 return Response.json({id});
 });assert.deepEqual(receipt,{providerMessageId:id});
});
test('missing key, invalid recipient and injected subject never call provider',async()=>{
 const deny=()=>{assert.fail('unexpected provider call')};
 for(const args of [[null,message],[key,{...message,toEmail:'x\n@example.invalid'}],[key,{...message,subject:'x\nBcc: y'}],[key,{...message,emailMessageId:'bad'}]])await assert.rejects(sendGuideViaResend(...args,deny));
});
test('provider rejection, timeout, and malformed receipt fail closed without retries',async()=>{
 for(const response of [()=>Response.json({error:'bad'},{status:429}),()=>Response.json({id:'invalid'}),()=>{throw Error('timeout')}]){let calls=0;await assert.rejects(sendGuideViaResend(key,message,async()=>{calls++;return response()}));assert.equal(calls,1);}
});
