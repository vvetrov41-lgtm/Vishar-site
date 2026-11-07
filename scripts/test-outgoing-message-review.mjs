import assert from 'node:assert/strict';
import { handleOutgoingMessageReview, isOutgoingMessageReviewPath, __testing } from '../workers/routes/outgoing-message-review.js';

const origin = 'https://crm.vishartattoo.com';
const url = 'https://api.vishartattoo.com/crm/outgoing-message-review';
const conversation = '11111111-1111-4111-8111-111111111111';
const email = '22222222-2222-4222-8222-222222222222';
const token = 'test.operator.session.token.abcdefghijklmnopqrstuvwxyz';
const env = { OUTGOING_AI_REVIEW_ENABLED:'true',
  SUPABASE_URL:'https://vfjexhfdbrjmuxfdvbdx.supabase.co',
  SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake_for_unit_tests' };
const data = { channel:'whatsapp', artist:'Tattoo Artist',
  rates:{hourly_rate:140,full_day_rate:980}, studio:{address:'Verified studio'},
  upcoming_sessions:[], projects:[], payment_requests:[], recent_messages:[] };
const req = (body, headers={}) => new Request(url,{method:'POST',headers:{
  Origin:origin, Authorization:'Bearer '+token, 'Content-Type':'application/json',...headers,
},body:JSON.stringify(body)});
const subject = {conversation_id:conversation,body:'A full day will be £900'};
let count=0;
async function test(name,fn){try{await fn();count++}catch(e){console.error('FAIL '+name,e);process.exitCode=1}}
await test('exact path only',()=>{assert.equal(isOutgoingMessageReviewPath(new Request(url)),true);
  assert.equal(isOutgoingMessageReviewPath(new Request(url+'/send')),false)});
await test('operator-scoped read RPC, no outbound send, and bounded warning output',async()=>{
  let calls=0;
  const response=await handleOutgoingMessageReview(req(subject),env,{
    fetchImpl:async(input,options)=>{
      calls++;
      assert.equal(new URL(input).pathname,'/rest/v1/rpc/get_outgoing_message_review_context');
      assert.equal(options.headers.authorization,'Bearer '+token);
      assert.equal(options.headers.apikey,env.SUPABASE_PUBLISHABLE_KEY);
      assert.deepEqual(JSON.parse(options.body),{p_conversation_id:conversation,p_email_message_id:null});
      return Response.json(data);
    },
    runTask:async(_env,task,input,opts)=>{
      assert.equal(task,'outgoing_message_review');
      assert.ok(input.input.includes('£900'));
      assert.ok(input.input.includes('980'));
      const output={issues:[{category:'price',message:'В тексте £900, в CRM £980.'}]};
      assert.equal(opts.validateJson(output),true);
      return {ok:true,json:output};
    }
  });
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);
  assert.deepEqual(await response.json(),{ok:true,issues:[{category:'price',message:'В тексте £900, в CRM £980.'}]});
  assert.equal(calls,1);
});
await test('email draft uses scoped email id only',async()=>{
  const response=await handleOutgoingMessageReview(req({email_message_id:email,body:'See you next week'}),env,{
    fetchImpl:async(_,opts)=>{
      assert.deepEqual(JSON.parse(opts.body),{p_conversation_id:null,p_email_message_id:email});
      return Response.json({...data,channel:'email'});
    },runTask:async()=>({ok:true,json:{issues:[]}})
  });
  assert.deepEqual(await response.json(),{ok:true,issues:[]});
});
await test('no bearer prevents both database lookup and inference',async()=>{
  let reads=0;
  const response=await handleOutgoingMessageReview(req(subject,{Authorization:'bad'}),env,{
    fetchImpl:async()=>{reads++;throw Error('no')}});assert.equal(response.status,401);assert.equal(reads,0);
});
await test('forbidden origin and injected pricing cannot reach inference',async()=>{
  let reads=0;const deps={fetchImpl:async()=>{reads++;throw Error('no')}};
  const denied=await handleOutgoingMessageReview(req(subject,{Origin:'https://evil.example'}),env,deps);
  assert.equal(denied.status,403);assert.equal(denied.headers.get('Access-Control-Allow-Origin'),null);
  const injected=await handleOutgoingMessageReview(req({...subject,artist_id:conversation}),env,deps);
  assert.equal(injected.status,400);assert.equal(reads,0);
});
await test('database refusal is fail closed',async()=>{
  const response=await handleOutgoingMessageReview(req(subject),env,{fetchImpl:async()=>new Response('{}',{status:403}),
    runTask:async()=>{throw Error('should not invoke AI')}});
  assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'access_denied'});
});
await test('failed AI review is never reported as clean',async()=>{
  const response=await handleOutgoingMessageReview(req(subject),env,{fetchImpl:async()=>Response.json(data),
    runTask:async()=>({ok:false,errorCode:'all_providers_failed'})});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'review_unavailable'});
});
await test('strict issue contract prevents arbitrary response leakage',()=>{
  assert.equal(__testing.validIssues({issues:[{category:'price',message:'ok'}]}),null);
  assert.equal(__testing.validIssues({issues:[{category:'send',message:'Send now please'}]}),null);
  assert.equal(__testing.validIssues({issues:[],text:'client text'}),null);
  assert.deepEqual(__testing.validIssues({issues:[]}),[]);
});
await test('kill switch and OPTIONS are safe',async()=>{
  const options=await handleOutgoingMessageReview(new Request(url,{method:'OPTIONS',headers:{Origin:origin}}),env);
  assert.equal(options.status,204);
  const disabled=await handleOutgoingMessageReview(req(subject),{...env,OUTGOING_AI_REVIEW_ENABLED:'false'});
  assert.equal(disabled.status,404);
});
console.log('Outgoing message AI review: '+count+' checks passed');
