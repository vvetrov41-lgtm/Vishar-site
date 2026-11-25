// Wake hints are not jobs. Database leases, version and send-intent guards own
// all effects. The public ingress takes the caller's existing CRM bearer and
// obtains bounded, artist-scoped hints from a read-only RPC; no DB webhooks.
const HOST = 'outbox-wake.vishartattoo.com';
const PATH = '/internal/outbox/wake';
const CRM_ORIGIN = 'https://crm.vishartattoo.com';
const DB_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const LANES = new Set(['calendar','whatsapp','email','instagram']);
const MAX_HINTS = 32;
const BEARER = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
function enabled(env) { return env.VISHAR_ENVIRONMENT === 'production' && env.OUTBOX_WAKE_ENABLED === 'true'; }
const json = (status,body,origin) => Response.json(body,{status,headers:{'cache-control':'no-store',...(origin===CRM_ORIGIN?{'access-control-allow-origin':CRM_ORIGIN,'vary':'Origin'}:{})}});
export function parseWake(value,now=Date.now()){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='due_ms,lane'
    ||!LANES.has(value.lane)||!Number.isSafeInteger(value.due_ms)||value.due_ms<now-600000||value.due_ms>now+300000)return null;
  return {lane:value.lane,delaySeconds:value.due_ms<=now?0:Math.ceil((value.due_ms-now)/1000)+1};
}
// A network POST with no body may still have a non-null, empty stream in workerd.
// Inspect at most four chunks, and fail closed on a stalled or non-empty body.
async function hasWakeBody(request){
 const length=request.headers.get('content-length');
 if(length!==null&&length!=='0')return true;
 if(!request.body)return false;
 const reader=request.body.getReader();
 let timer;
 try{
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);});
  for(let i=0;i<4;i++){
   const chunk=await Promise.race([reader.read(),deadline]);
   if(!chunk)return true;
   if(chunk.done)return false;
   if(chunk.value?.byteLength!==0)return true;
  }
  return true;
 }catch{return true;}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export async function receiveWake(request,env,now=Date.now(),fetchImpl=fetch){
  const url=new URL(request.url);
  const origin=request.headers.get('origin');
  if(url.protocol!=='https:'||url.hostname!==HOST||url.pathname!==PATH||url.search||url.hash||!enabled(env))return json(404,{ok:false},origin);
  if(origin&&origin!==CRM_ORIGIN)return json(403,{ok:false});
  if(request.method==='OPTIONS'){
    if(origin!==CRM_ORIGIN||request.headers.get('access-control-request-method')!=='POST')return json(403,{ok:false},origin);
    return new Response(null,{status:204,headers:{'access-control-allow-origin':CRM_ORIGIN,'access-control-allow-methods':'POST','access-control-allow-headers':'authorization','access-control-max-age':'600','vary':'Origin','cache-control':'no-store'}});
  }
  if(request.method!=='POST')return json(400,{ok:false},origin);
  const authorization=request.headers.get('authorization')||'';
  if(authorization.length>8192||!BEARER.test(authorization))return json(401,{ok:false},origin);
  if(env.SUPABASE_URL!==DB_ORIGIN||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY||'')
    ||typeof env.OUTBOX_WAKE_RATE_LIMIT?.limit!=='function'||typeof env.OUTBOX_WAKE_QUEUE?.send!=='function')return json(503,{ok:false},origin);
  try {
    const limit=await env.OUTBOX_WAKE_RATE_LIMIT.limit({key:request.headers.get('cf-connecting-ip')||'unknown'});
    if(!limit.success)return json(429,{ok:false},origin);
    if(await hasWakeBody(request))return json(400,{ok:false},origin);
    const response=await fetchImpl(DB_ORIGIN+'/rest/v1/rpc/get_booking_outbox_wake_hints',{
      method:'POST',headers:{authorization,apikey:env.SUPABASE_PUBLISHABLE_KEY,'content-type':'application/json'},body:'{}',redirect:'manual'
    });
    if(response.status===401||response.status===403)return json(403,{ok:false},origin);
    if(!response.ok)return json(503,{ok:false},origin);
    const values=await response.json();
    if(!Array.isArray(values)||values.length>MAX_HINTS)return json(503,{ok:false},origin);
    const hints=values.map(value=>parseWake(value,now));
    if(hints.some(hint=>!hint))return json(503,{ok:false},origin);
    await Promise.all(hints.map(hint=>env.OUTBOX_WAKE_QUEUE.send({lane:hint.lane},{delaySeconds:hint.delaySeconds})));
    return json(202,{ok:true},origin);
  }catch{return json(503,{ok:false},origin);}
}
const routes={
  calendar:['CALENDAR_SERVICE','https://calendar.internal/internal/calendar/wake'],
  whatsapp:['WHATSAPP_SERVICE','https://whatsapp.internal/internal/whatsapp/wake'],
  instagram:['INSTAGRAM_SERVICE','https://instagram.internal/internal/instagram/wake'],
};
export async function drainLane(env,lane){
  if(lane==='email'){
    if(typeof env.GMAIL_SERVICE?.drainApprovedEmailOutbox!=='function')throw Error('wake_binding_unavailable');
    const summary=await env.GMAIL_SERVICE.drainApprovedEmailOutbox();
    if(!summary || !Number.isInteger(summary.processed) || summary.processed<0)throw Error('wake_summary_invalid');
    return;
  }
  if(!LANES.has(lane)||!routes[lane])throw Error('wake_lane_invalid');
  const [binding,url]=routes[lane];
  if(typeof env[binding]?.fetch!=='function')throw Error('wake_binding_unavailable');
  const response=await env[binding].fetch(url,{method:'POST'});
  if(!response.ok || (await response.json())?.ok!==true)throw Error('wake_drain_unavailable');
}
export async function consumeWake(batch,env){
  const groups=new Map();
  for(const message of batch.messages){
    const lane=message.body?.lane;
    if(!enabled(env)||!LANES.has(lane)||Object.keys(message.body).length!==1){message.ack();continue;}
    if(!groups.has(lane))groups.set(lane,[]);
    groups.get(lane).push(message);
  }
  await Promise.all([...groups].map(async ([lane,messages])=>{
    try{
      await drainLane(env,lane);
      for(const message of messages)message.ack();
    }catch{
      // Retry only a wake hint, never a provider message; DB lease/send intent
      // owns replay safety. The existing cron is the fallback if all wakes fail.
      console.error('outbox wake failed',JSON.stringify({lane}));
      for(const message of messages)message.retry({delaySeconds:15});
    }
  }));
}
export function isWakeRequest(request,host,path){
  const url=new URL(request.url);
  return url.protocol==='https:'&&url.hostname===host&&url.pathname===path&&!url.search&&!url.hash&&request.method==='POST';
}
export async function handleDrainWake(env,enabledFlag,drain){
  if(env.VISHAR_ENVIRONMENT!=='production'||env[enabledFlag]!=='true')return json(200,{ok:true,skipped:true});
  try {await drain(env);return json(200,{ok:true});}
  catch{return json(503,{ok:false});}
}
