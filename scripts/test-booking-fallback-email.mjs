#!/usr/bin/env node
import assert from 'node:assert/strict';
import { formatFailedBooking, deliverFailedBookingMail } from '../workers/lib/booking-fallback-email.js';

const payload={
  artist:'kristina',origin:'https://www.kristinavishar.com',
  idempotencyKey:'11111111-2222-4333-8444-555555555555',
  failureCode:'enquiry_rejected',privacyAcknowledged:true,
  privacyNoticeVersion:'2026-11-03',name:'Client Test',email:'client@example.test',
  phone:'+447700900001',preferredReply:'Email',
  idea:'Black and grey sleeve',placement:'Forearm',size:'20cm',
  files:[{name:'reference.jpg',size:1024}],
  attachments:[{name:'reference.jpg',mimeType:'image/jpeg',bytes:new Uint8Array([255,216,255,12])}],
};
let count=0;
const test=(desc,fn)=>{try{fn();count++;}catch(e){console.error('FAIL',desc,e);process.exitCode=1;}};
test('Kristina route is hardcoded, never chosen by user',()=>{
  const mail=formatFailedBooking({...payload,toEmail:'attacker@example.com'});
  assert.equal(mail.toEmail,'bookings@kristinavishar.com');
  assert.match(mail.body,/Client Test/);
  assert.match(mail.body,/reference.jpg/);
  assert.match(mail.body,/All validated reference images are attached/);
  assert.equal(mail.attachments.length,1);
  assert.match(mail.body,/NOT confirmed as saved/);
  assert.doesNotMatch(mail.body,/attacker@example.com/);
});
test('Vladimir backup arrives in verified personal Gmail',()=>{
  const mail=formatFailedBooking({...payload,artist:'vladimir',origin:'https://vishartattoo.com'});
  assert.equal(mail.toEmail,'vvetrov41@gmail.com');
});
test('wrong origin, consent, failure state and malicious filename rejected',()=>{
  for(const change of [
    {origin:'https://attacker.example'},{privacyAcknowledged:false},
    {failureCode:'invalid_email'},{idempotencyKey:'not-uuid'},
    {files:[{name:'oversized',size:20*1024*1024}]},
    {attachments:[{name:'x.jpg',mimeType:'text/html',bytes:new Uint8Array([1,2])}]},
  ])assert.throws(()=>formatFailedBooking({...payload,...change}));
});
const mocks={
  VISHAR_ENVIRONMENT:'production',
  GMAIL_VLADIMIR_ENABLED:'true',
  GMAIL_OAUTH_TOKENS:{},
};
const sent=[];
const result=await deliverFailedBookingMail(mocks,payload,{
  async refresh(_env,id){assert.equal(id,'a1111111-1111-4111-8111-111111111111');return{
    accessToken:'fake-in-memory-token',
    stored:{integration_key:'google_gmail_vladimir',mailbox_email:'vvetrov41@gmail.com'},
  };},
  async profile(){return {emailAddress:'vvetrov41@gmail.com'};},
  async send(_token,opts){sent.push(opts);return {providerMessageId:'stub',deduplicated:false};},
});
assert.deepEqual(result,{accepted:true,deduplicated:false});
assert.equal(sent.length,1);
assert.equal(sent[0].toEmail,'bookings@kristinavishar.com');
assert.equal(sent[0].emailMessageId,payload.idempotencyKey);
await assert.rejects(deliverFailedBookingMail({},payload),/booking_fallback_disabled/);
await assert.rejects(deliverFailedBookingMail(mocks,{...payload,origin:'https://bad.example'}),/booking_fallback_payload_invalid/);
if(!process.exitCode)console.log('Independent booking fallback email checks passed ('+(count+3)+' assertions/groups)');
