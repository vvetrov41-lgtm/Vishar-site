// Wake hints are not jobs: the existing database leases, due times, version
// checks and send-intent guards remain authoritative. No client data leaves DB.
const HOST = 'outbox-wake.vishartattoo.com';
const PATH = '/internal/outbox/wake';
const LANES = new Set(['calendar','whatsapp','email','instagram']);
const MAX_DELAY_SECONDS = 300;
const MAX_BODY = 256;
const KEY = /^[a-f0-9]{64}$/;
const json = (status, body) => Response.json(body, {status, headers:{'cache-control':'no-store'}});
function enabled(env) { return env.VISHAR_ENVIRONMENT === 'production' && env.OUTBOX_WAKE_ENABLED === 'true'; }
async function authenticated(request, env) {
  const expected = env.OUTBOX_WAKE_SECRET;
  const supplied = request.headers.get('x-outbox-wake-key') || '';
  if (!KEY.test(expected || '') || !KEY.test(supplied)) return false;
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [a,b] = await Promise.all([digest(expected),digest(supplied)]);
  let diff = 0;
  for (let i=0;i<a.length;i++) diff |= a[i]^b[i];
  return diff === 0;
}
export function parseWake(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'due_at,lane'
      || !LANES.has(value.lane) || typeof value.due_at !== 'string') return null;
  const due = Date.parse(value.due_at);
  if (!Number.isFinite(due) || due < now-600000 || due > now+MAX_DELAY_SECONDS*1000) return null;
  return {lane:value.lane, delaySeconds:due <= now ? 0 : Math.ceil((due-now)/1000)+1};
}
export async function receiveWake(request, env, now = Date.now()) {
  const url = new URL(request.url);
  if (url.hostname !== HOST || url.pathname !== PATH || url.search || url.hash || request.method !== 'POST' || !enabled(env)) return json(404,{ok:false});
  if (!await authenticated(request,env)) return json(401,{ok:false});
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json(415,{ok:false});
  const reader = request.body?.getReader();
  if (!reader) return json(400,{ok:false});
  const chunks=[]; let length=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      length+=value.byteLength;
      if (length>MAX_BODY) { await reader.cancel(); return json(413,{ok:false}); }
      chunks.push(value);
    }
  } catch {return json(400,{ok:false});}
  const bytes=new Uint8Array(length); let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let value;
  try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{return json(400,{ok:false});}
  const wake=parseWake(value,now);
  if(!wake)return json(400,{ok:false});
  if(typeof env.OUTBOX_WAKE_QUEUE?.send!=='function')return json(503,{ok:false});
  try{
    await env.OUTBOX_WAKE_QUEUE.send({lane:wake.lane},{delaySeconds:wake.delaySeconds});
    return json(202,{ok:true});
  }catch{return json(503,{ok:false});}
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
