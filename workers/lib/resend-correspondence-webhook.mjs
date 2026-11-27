// Pure verification and normalization; no public route is registered yet.
// A verified event is still untrusted for routing until the receipt's
// provider email ID, sender, recipient and artist are matched to durable state.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID=/^[a-zA-Z0-9_-]{8,200}$/;
const RFC_ID=/^<[^\s<>]+>$/;
const EVENTS=new Set(['email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed']);
const SENDER='info@vishartattoo.com';
const MAX_SKEW=300;
const enc=new TextEncoder();
function fromBase64(s) {
  if(typeof s!=='string'||!s||s.length>512||!/^[A-Za-z0-9+/]+={0,2}$/.test(s))throw Error('resend_webhook_invalid');
  return Uint8Array.from(atob(s),c=>c.charCodeAt(0));
}
function address(value) {
  if(typeof value!=='string'||value.length>512||/[\r\n\0]/.test(value))return null;
  const match=value.trim().match(/^(?:[^<>]*<([^<>]+)>|([^<>]+))$/);
  const email=(match?.[1]||match?.[2]||'').trim().toLowerCase();
  return email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?email:null;
}
export async function verifyResendEvent({rawBody,headers,secret,nowSeconds=Math.floor(Date.now()/1000)}) {
  if(typeof rawBody!=='string'||enc.encode(rawBody).length>65536||typeof secret!=='string'||!secret.startsWith('whsec_'))throw Error('resend_webhook_invalid');
  const id=headers?.get('svix-id'),ts=headers?.get('svix-timestamp'),sig=headers?.get('svix-signature');
  if(!EVENT_ID.test(id||'')||!/^\d{1,12}$/.test(ts||'')||!Number.isSafeInteger(nowSeconds)||Math.abs(nowSeconds-Number(ts))>MAX_SKEW||typeof sig!=='string'||sig.length>4096)throw Error('resend_webhook_invalid');
  const keyBytes=fromBase64(secret.slice(6));
  if(keyBytes.length<32)throw Error('resend_webhook_invalid');
  const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const message=enc.encode(id+'.'+ts+'.'+rawBody);
  let verified=false;
  for(const candidate of sig.split(/ +/).slice(0,10)){
    const [version,signature,extra]=candidate.split(',');
    if(version!=='v1'||extra!==undefined)continue;
    try{const bytes=fromBase64(signature);if(bytes.length===32&&await crypto.subtle.verify('HMAC',key,bytes,message))verified=true;}catch{}
  }
  if(!verified)throw Error('resend_webhook_signature_invalid');
  let event;
  try{event=JSON.parse(rawBody);}catch{throw Error('resend_webhook_invalid');}
  if(!EVENTS.has(event?.type))return null;
  const d=event.data;
  const from=address(d?.from);
  const to=Array.isArray(d?.to)?d.to.map(address):[];
  const createdAt=Date.parse(event.created_at);
  if(!UUID.test(d?.email_id||'')||!from||!to.length||to.length>50||to.some(x=>!x)||!Number.isFinite(createdAt))throw Error('resend_webhook_invalid');
  // Other senders on a shared account are ignored, never processed.
  if(from!==SENDER)return null;
  const rfcMessageId=d.message_id==null?null:d.message_id;
  if(rfcMessageId!==null&&(typeof rfcMessageId!=='string'||rfcMessageId.length>998||!RFC_ID.test(rfcMessageId)))throw Error('resend_webhook_invalid');
  // Do not retain body, headers, provider raw data or credentials.
  return {eventId:id,providerMessageId:d.email_id.toLowerCase(),type:event.type,from,to:[...new Set(to)],rfcMessageId,createdAt:new Date(createdAt).toISOString()};
}
