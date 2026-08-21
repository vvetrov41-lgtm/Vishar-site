#!/usr/bin/env node
import assert from 'node:assert/strict';
import tattooaiEntry from '../workers/tattooai-entry.js';
import { handleEnquiryIntake } from '../workers/routes/enquiries.js';
import {
  getCorsHeaders,
  isRegistryBookingRequest,
} from '../workers/lib/http.js';
import {
  readBookingSourcePublicId,
  SUPPORTED_BOOKING_FORM_VERSION,
} from '../workers/lib/provider-routing.js';
import { ALLOWED_RPCS, READ_ONLY_RPCS } from '../workers/lib/supabase.js';

const SOURCE_ID='39680fe5-6da0-48c0-bb6b-b543928747e2';
const ORIGIN='https://artist.example';
const ENDPOINT=`https://tattooai.example/?source=${SOURCE_ID}`;
const logger={info(){},warn(){},error(){}};
const env={
  SUPABASE_URL:'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY:'legacy-test-key',
};

let passes=0;
let failures=0;
async function test(name,fn){
  try{await fn();passes+=1;}
  catch(error){failures+=1;console.error(`FAIL ${name}`);console.error(`     ${error.stack||error.message}`);}
}

function honeypotRequest({origin=ORIGIN,sourceId=SOURCE_ID}={}){
  const form=new FormData();
  form.append('idempotencyKey','11111111-2222-4333-8444-555555555555');
  form.append('website','bot-filled-this');
  const url=`https://tattooai.example/?source=${sourceId}`;
  return new Request(url,{method:'POST',headers:{Origin:origin},body:form});
}

function resolverFetch({status=200,formVersion=SUPPORTED_BOOKING_FORM_VERSION}={}){
  const calls=[];
  const fetchImpl=async (url,init={})=>{
    const href=String(url);
    calls.push({href,body:init.body?JSON.parse(init.body):null});
    assert.match(href,/\/rest\/v1\/rpc\/resolve_booking_source_public$/);
    if(status!==200)return new Response('{}',{status});
    return Response.json([{
      booking_source_id:'b1111111-1111-4111-8111-111111111111',
      artist_id:'a1111111-1111-4111-8111-111111111111',
      source_key:'artist-website',
      form_version:formVersion,
    }]);
  };
  return {calls,fetchImpl};
}

await test('registry selector is a strict public UUID and never artist_id',()=>{
  assert.equal(readBookingSourcePublicId(new Request(ENDPOINT)),SOURCE_ID);
  assert.equal(readBookingSourcePublicId(new Request('https://tattooai.example/')),null);
  assert.throws(
    ()=>readBookingSourcePublicId(new Request('https://tattooai.example/?source=artist-vladimir')),
    error=>error.code==='booking_source_invalid'&&error.status===400
  );
  assert.equal(
    readBookingSourcePublicId(new Request(`https://tattooai.example/?artist_id=a1111111-1111-4111-8111-111111111111&source=${SOURCE_ID}`)),
    SOURCE_ID
  );
});

await test('dynamic CORS is browser plumbing, limited to registry booking requests',()=>{
  const post=honeypotRequest();
  assert.equal(isRegistryBookingRequest(post),true);
  assert.equal(getCorsHeaders(ORIGIN,{},post)['Access-Control-Allow-Origin'],ORIGIN);

  const preflight=new Request(ENDPOINT,{method:'OPTIONS',headers:{Origin:ORIGIN}});
  assert.equal(isRegistryBookingRequest(preflight),true);
  assert.equal(getCorsHeaders(ORIGIN,{},preflight)['Access-Control-Allow-Origin'],ORIGIN);

  const json=new Request(ENDPOINT,{
    method:'POST',
    headers:{Origin:ORIGIN,'Content-Type':'application/json'},
    body:'{}',
  });
  assert.equal(isRegistryBookingRequest(json),false);
  assert.notEqual(getCorsHeaders(ORIGIN,{},json)['Access-Control-Allow-Origin'],ORIGIN);
});

await test('production entrypoint handles external registry preflight without a static Origin binding',async()=>{
  const preflight=new Request(ENDPOINT,{
    method:'OPTIONS',
    headers:{
      Origin:ORIGIN,
      'Access-Control-Request-Method':'POST',
      'Access-Control-Request-Headers':'Content-Type',
    },
  });
  const response=await tattooaiEntry.fetch(preflight,{});
  assert.equal(response.status,204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
  assert.match(response.headers.get('Access-Control-Allow-Methods')||'',/POST/);
});

await test('production entrypoint does not broaden non-registry preflight CORS',async()=>{
  const request=new Request('https://tattooai.example/',{
    method:'OPTIONS',
    headers:{Origin:ORIGIN},
  });
  const response=await tattooaiEntry.fetch(request,{});
  assert.notEqual(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
});

await test('registry intake resolves source plus exact Origin before parsing or persistence',async()=>{
  const {calls,fetchImpl}=resolverFetch();
  const response=await handleEnquiryIntake(honeypotRequest(),env,{
    cors:{},logger,fetchImpl,
  });
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
  assert.equal(calls.length,1,'honeypot performs only the read-only registry lookup');
  assert.deepEqual(calls[0].body,{
    p_public_source_id:SOURCE_ID,
    p_origin:ORIGIN,
  });
});

await test('a mismatched public id or Origin is refused before persistence',async()=>{
  const {calls,fetchImpl}=resolverFetch({status:400});
  const response=await handleEnquiryIntake(honeypotRequest(),env,{
    cors:{},logger,fetchImpl,
  });
  const payload=await response.json();
  assert.equal(response.status,403);
  assert.equal(payload.code,'origin_not_allowed');
  assert.equal(calls.length,1);
  assert.match(calls[0].href,/resolve_booking_source_public$/);
});

await test('an unsupported source form version fails closed before body processing',async()=>{
  const {calls,fetchImpl}=resolverFetch({formVersion:'booking-v2'});
  const response=await handleEnquiryIntake(honeypotRequest(),env,{
    cors:{},logger,fetchImpl,
  });
  const payload=await response.json();
  assert.equal(response.status,500);
  assert.equal(payload.code,'booking_form_version_unsupported');
  assert.equal(calls.length,1);
});

await test('malformed public ids fail before the Worker sends its backend key anywhere',async()=>{
  let called=false;
  const response=await handleEnquiryIntake(
    honeypotRequest({sourceId:'not-a-uuid'}),
    env,
    {cors:{},logger,fetchImpl:async()=>{called=true;throw new Error('must not run');}}
  );
  const payload=await response.json();
  assert.equal(response.status,400);
  assert.equal(payload.code,'booking_source_invalid');
  assert.equal(called,false);
});

await test('legacy deployed forms remain compatible during the rollout',async()=>{
  const legacyEnv={
    ...env,
    BOOKING_SOURCE_KEY:'vladimir-website',
    BOOKING_FORM_VERSION:'booking-v1',
  };
  const form=new FormData();
  form.append('idempotencyKey','11111111-2222-4333-8444-555555555555');
  form.append('website','bot-filled-this');
  const request=new Request('https://tattooai.example/',{
    method:'POST',headers:{Origin:'https://vishartattoo.com'},body:form,
  });
  let called=false;
  const response=await handleEnquiryIntake(request,legacyEnv,{
    cors:getCorsHeaders('https://vishartattoo.com',legacyEnv,request),
    logger,
    fetchImpl:async()=>{called=true;throw new Error('honeypot must not call backend');},
  });
  assert.equal(response.status,200);
  assert.equal(called,false);
});

await test('the privileged Worker surface isolates one read-only resolver from the legacy RPC set',()=>{
  assert.deepEqual([...READ_ONLY_RPCS],['resolve_booking_source_public']);
  assert.equal(ALLOWED_RPCS.has('resolve_booking_source_public'),false);
  for(const forbidden of ['sql','query','select','insert','update','delete']){
    assert.equal(ALLOWED_RPCS.has(forbidden),false);
    assert.equal(READ_ONLY_RPCS.has(forbidden),false);
  }
});

if(failures){
  console.error(`\n${failures} failed, ${passes} passed`);
  process.exitCode=1;
}else{
  console.log(`${passes} booking source registry tests passed`);
}