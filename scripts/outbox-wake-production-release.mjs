import {queueOwnedBy} from './outbox-wake-queue-inventory.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
const NAME='vishar-outbox-wake-production';
const HOST='outbox-wake.vishartattoo.com';
const DB='https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const PROVIDERS=[
 ['CALENDAR_SERVICE','vishar-calendar-production','CALENDAR_DRAIN_ENABLED','/internal/calendar/wake'],
 ['WHATSAPP_SERVICE','vishar-whatsapp-drain-production','WHATSAPP_DRAIN_ENABLED','/internal/whatsapp/wake'],
 ['INSTAGRAM_SERVICE','vishar-instagram-production','INSTAGRAM_DRAIN_ENABLED','/internal/instagram/wake'],
 ['GMAIL_SERVICE','vishar-gmail-production','GMAIL_DRAIN_ENABLED','drainApprovedEmailOutbox'],
];
const fail=(s)=>{throw new Error(s);};
const mode=process.argv[2],phase=process.argv[3];
const activating=mode==='activate';
if(!['prepare','activate'].includes(mode)||!['preflight','readback'].includes(phase))fail('Invalid release mode');
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN,key=process.env.SUPABASE_PUBLISHABLE_KEY;
if(!/^[0-9a-f]{32}$/.test(account||'')||!token||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key||'')||process.env.SUPABASE_URL!==DB)fail('Production credentials or target missing');
const root='https://api.cloudflare.com/client/v4/accounts/'+account;
async function api(path,{method='GET',body,raw=false,missing=false}={}){
 const res=await fetch(root+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error'});
 if(missing&&res.status===404)return null;
 if(!res.ok)fail('Cloudflare control-plane request failed: '+method+' '+path+' '+res.status);
 if(raw)return res.text();
 const result=await res.json();if(result.success!==true)fail('Cloudflare operation rejected: '+path);return result.result;
}
const workerPath=(n)=>'/workers/scripts/'+n;
async function worker(n,missing=false){
 const s=await api(workerPath(n)+'/settings',{missing});
 if(s===null)return null;
 const d=await api(workerPath(n)+'/deployments');
 const versions=(d.deployments?.[0]||d[0])?.versions;
 if(!Array.isArray(versions)||versions.length!==1||versions[0].percentage!==100||!versions[0].version_id)fail('Unexpected active deployment for '+n);
 const bindings=new Map((s.bindings||[]).map(x=>[x.name,x]));
 return {version:versions[0].version_id,bindings};
}
function flag(w,n,value){if(w?.bindings.get(n)?.text!==value)fail('Unexpected live flag: '+n);}
async function inventory(){
 const domains=await api('/workers/domains?hostname='+HOST);
 if(!Array.isArray(domains)||domains.some(x=>x.hostname===HOST&&x.service!==NAME))fail('Custom domain occupied');
 const owned=await api('/workers/domains?service='+NAME);
 if(!Array.isArray(owned)||owned.some(x=>x.hostname!==HOST))fail('Unexpected wake Worker domain');
 const queues=await api('/queues?name='+NAME);
 if(!Array.isArray(queues))fail('Queue inventory unavailable');
 const matches=queues.filter(x=>x.queue_name===NAME);
 if(matches.length>1)fail('Duplicate queue name');
 const queue=matches[0]||null;
 if(queue&&!queueOwnedBy(queue,NAME))fail('Queue belongs to another service or its inventory is incomplete');
 return {domain:domains.find(x=>x.hostname===HOST)||null,queue,wake:await worker(NAME,true)};
}
async function providers(){
 for(const [,name,enabled,marker] of PROVIDERS){
  const w=await worker(name);flag(w,'VISHAR_ENVIRONMENT','production');
  if(activating){
   flag(w,enabled,'true');
   const src=await api(workerPath(name)+'/content/v2',{raw:true});
   if(!src.includes(marker))fail('Provider wake entrypoint has not been deployed: '+name);
  }
 }
}
async function verifyWake(state,enabled){
 if(!state.wake||!state.domain||!state.queue)fail('Wake deployment is incomplete');
 flag(state.wake,'VISHAR_ENVIRONMENT','production');flag(state.wake,'OUTBOX_WAKE_ENABLED',enabled?'true':'false');flag(state.wake,'SUPABASE_URL',DB);
 for(const [binding,service] of PROVIDERS){const v=state.wake.bindings.get(binding);if(v?.type!=='service'||v.service!==service)fail('Incorrect provider binding: '+binding);}
 const q=state.wake.bindings.get('OUTBOX_WAKE_QUEUE');
 if(q?.type!=='queue'||q.queue_name!==NAME)fail('Incorrect queue producer binding');
 if(!state.wake.bindings.has('OUTBOX_WAKE_RATE_LIMIT'))fail('Missing wake rate limit');
 if(!queueOwnedBy(state.queue,NAME,true))fail('Queue producer/consumer readback failed');
 const src=await api(workerPath(NAME)+'/content/v2',{raw:true});
 if(!src.includes('get_booking_outbox_wake_hints')||!src.includes('/internal/outbox/wake'))fail('Wrong deployed wake source');
 const unauthorized=await fetch('https://'+HOST+'/internal/outbox/wake',{method:'POST',redirect:'manual'});
 if(unauthorized.status!==(enabled?401:404))fail('Public ingress did not fail closed: '+unauthorized.status);
}
try{
 const state=await inventory();
 if(phase==='preflight'){
  await providers();
  if(activating){
   await verifyWake(state,false);
   // Anonymous callers must reach an installed, non-public RPC, not a missing
   // endpoint. This is a read-only request with no client data.
   const r=await fetch(DB+'/rest/v1/rpc/get_booking_outbox_wake_hints',{method:'POST',headers:{apikey:key,'content-type':'application/json'},body:'{}',redirect:'error'});
   if(![401,403].includes(r.status))fail('Wake database RPC is not installed or not access-controlled');
  }else if(state.wake){await verifyWake(state,false);}
  else if(state.domain)fail('Orphan wake domain; reconcile before deploying');
  const path=process.env.WAKE_DEPLOY_CONFIG;
  if(!path||!path.startsWith('.wrangler/'))fail('Expected ephemeral deployment configuration');
  const template=readFileSync('wrangler.outbox-wake.production.toml','utf8');
  if((template.match(/^OUTBOX_WAKE_ENABLED = "false"$/gm)||[]).length!==1)fail('Tracked config must be disabled');
  if(!template.includes('name = "'+NAME+'"')||!template.includes('SUPABASE_URL = "'+DB+'"'))fail('Wrong tracked config');
  const generated=template.replace('OUTBOX_WAKE_ENABLED = "false"','OUTBOX_WAKE_ENABLED = "'+(activating?'true':'false')+'"'+ '\nSUPABASE_PUBLISHABLE_KEY = "'+key+'"').replace('main = "workers/outbox-wake.js"','main = "../workers/outbox-wake.js"');
  writeFileSync(path,generated,{mode:0o600});
  if(state.wake&&process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,'previous_version='+state.wake.version+'\n',{flag:'a'});
  if(!state.queue){
   if(activating)fail('Cannot activate before queue preparation');
   await api('/queues',{method:'POST',body:{queue_name:NAME}});
   const after=await inventory();if(!after.queue||after.queue.queue_name!==NAME)fail('Queue creation readback failed');
  }
  console.log('Wake production preflight passed: '+mode);
 }else{
  await verifyWake(state,activating);
  console.log('Wake production readback passed: '+mode+'; active version '+state.wake.version);
 }
}catch(e){console.error('Wake release failed: '+e.message);process.exitCode=1;}
