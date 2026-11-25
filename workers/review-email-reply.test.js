import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healingReplyInThread, pollReviewEmailReplies } from './lib/review-email-reply.js';
const candidate = {
  email_message_id: 'e9950000-0000-4000-8000-000000000001',
  client_email: 'client@example.test', provider_thread_id: 'thread1',
  provider_message_id: 'send1', rfc822_message_id: '<healing@example.test>',
  healing_asked_at: '2026-11-25T10:00:00Z',
};
const sent = { direction:'outbound', provider_message_id:'send1',
  _rfc822_message_id:'<healing@example.test>', timestamp:'2026-11-25T10:01:00Z' };
const reply = { direction:'inbound', provider_message_id:'reply1',
  _in_reply_to:'<healing@example.test>', timestamp:'2026-11-25T10:03:00Z', body:'Healed well!\n> old text' };
const thread = { providerThreadId:'thread1', _bilateral:true, messages:[sent,reply] };
test('exact healing message and bilateral reply only', () => {
  assert.deepEqual(healingReplyInThread(thread,candidate), { id:'reply1',at:reply.timestamp,text:'Healed well!' });
  assert.equal(healingReplyInThread({...thread,providerThreadId:'wrong1'},candidate),null);
  assert.equal(healingReplyInThread({...thread,_bilateral:false},candidate),null);
  assert.equal(healingReplyInThread({...thread,messages:[reply]},candidate),null);
  assert.equal(healingReplyInThread({...thread,messages:[sent,{...reply,_in_reply_to:'<unrelated@example.test>'}]},candidate),null);
  assert.equal(healingReplyInThread({...thread,messages:[sent,{...reply,timestamp:'2026-11-25T10:00:30Z'}]},candidate),null);
});
test('poll records only verified reply, never sends; disabled drain cannot advertise readiness', async () => {
  const calls=[];
  const env={VISHAR_ENVIRONMENT:'production',GMAIL_READ_ENABLED:'true',GMAIL_DRAIN_ENABLED:'true'};
  const mailbox={artist_id:'a1111111-1111-4111-8111-111111111111',integration_key:'gmail-test',external_account_label:'artist@example.test'};
  const rpc=async (_env,name,args)=>{ calls.push({name,args}); return name==='service_list_review_email_checks' ? [candidate] : null; };
  await pollReviewEmailReplies({env,mailbox,accessToken:'test-token',rpc,readThread:async()=>thread});
  assert.equal(calls.length,2);
  assert.equal(calls[1].name,'service_record_review_email_check');
  assert.equal(calls[1].args.p_reply_id,'reply1');
  calls.length=0;
  await pollReviewEmailReplies({env:{...env,GMAIL_DRAIN_ENABLED:'false'},mailbox,accessToken:'test-token',rpc,readThread:async()=>thread});
  assert.equal(calls.length,0);
});
