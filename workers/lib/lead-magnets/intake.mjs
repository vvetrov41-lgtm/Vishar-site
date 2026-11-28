import { isGuidePilotRecipient } from './pilot.mjs';
// Isolated release-candidate intake adapter. NOT wired to a production route.
// Wire only to the verified artist-owned Worker route after the CRM migration is accepted.
const WEB_ORIGIN = 'https://vishartattoo.com';
const ROUTE = '/api/lead-magnets/cover-up-guide';
const EXPECTED_DOWNLOAD = `${WEB_ORIGIN}/assets/lead-magnets/cover-up-guide-v7.pdf`;
const CONSENT_VERSION = 'coverup-email-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UTM_KEYS = new Set(['utm_source','utm_medium','utm_campaign','utm_content','utm_term']);
const response = (code, body, origin) => new Response(body === null ? null : JSON.stringify(body), {status:code,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===WEB_ORIGIN?{'Access-Control-Allow-Origin':WEB_ORIGIN,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}:{})}});
function str(x, max) { return typeof x === 'string' && x.length <= max ? x.trim() : null; }
async function readBoundedJSON(request, max=8192) {
  if (!request.body) throw new Error('body_required');
  const reader=request.body.getReader(); let length=0;const chunks=[];
  try { while(true) { const {done,value}=await reader.read(); if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw new Error('body_too_large');} chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(length);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.byteLength;}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('body_invalid');return result;
}
export function validAttribution(a) {
  if (!a || typeof a!=='object' || Array.isArray(a)) return false;
  const keys=Object.keys(a); if (!keys.length) return true;
  if (a.consent_version!=='guide-attribution-v1') return false;
  return keys.every(k=>k==='consent_version' || (UTM_KEYS.has(k) && typeof a[k]==='string' && a[k].length<=160 && /^[A-Za-z0-9_.-]+$/.test(a[k])));
}
export async function handleLeadMagnetIntake(request, env, deps) {
  const url=new URL(request.url), origin=request.headers.get('Origin');
  if(url.pathname!==ROUTE) return null;
  if(url.origin!=='https://api.vishartattoo.com') return response(404,{ok:false,error:'not_found'},null);
  if(origin!==WEB_ORIGIN) return response(403,{ok:false,error:'origin_not_allowed'},origin);
  if(env.LEAD_MAGNET_INTAKE_ENABLED!=='true') return response(503,{ok:false,error:'not_available'},origin);
  if(request.method==='OPTIONS') return response(204,null,origin);
  if(request.method!=='POST') return response(405,{ok:false,error:'method_not_allowed'},origin);
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))return response(415,{ok:false,error:'content_type'},origin);
  // Fail closed when Cloudflare's rate limiter or trusted source address is unavailable.
  const address=request.headers.get('CF-Connecting-IP');
  if(!address||typeof deps?.rateLimit!=='function'||typeof deps?.capture!=='function') return response(503,{ok:false,error:'not_available'},origin);
  try { if(!await deps.rateLimit(address))return response(429,{ok:false,error:'rate_limited'},origin); }
  catch { return response(503,{ok:false,error:'not_available'},origin); }
  let b;try { b=await readBoundedJSON(request); } catch { return response(400,{ok:false,error:'invalid_body'},origin); }
  const allowed=new Set(['request_id','first_name','email','marketing_opt_in','marketing_consent_version','website','attribution']);
  if(Object.keys(b).some(k=>!allowed.has(k)))return response(400,{ok:false,error:'invalid_fields'},origin);
  const name=str(b.first_name,80), email=str(b.email,254)?.toLowerCase();
  if(!UUID.test(b.request_id||'')||!name||/[\r\n\x00-\x1f]/.test(name)||!email||!EMAIL.test(email)||typeof b.marketing_opt_in!=='boolean'||b.marketing_consent_version!==CONSENT_VERSION||b.website!=='')return response(400,{ok:false,error:'invalid_fields'},origin);
  if(!validAttribution(b.attribution))return response(400,{ok:false,error:'invalid_attribution'},origin);
  if(env.VISHAR_ENVIRONMENT==='production' && (b.marketing_opt_in || !await isGuidePilotRecipient(email)))return response(403,{ok:false,error:'pilot_restricted'},origin);
  try {
    const row=await deps.capture({p_artist_slug:'vladimir',p_magnet_slug:'cover-up-guide',p_request_id:b.request_id,p_first_name:name,p_email:email,p_marketing_opt_in:b.marketing_opt_in,p_consent_version:CONSENT_VERSION,p_attribution:b.attribution});
    if(!row||row.ok!==true||row.download_url!==EXPECTED_DOWNLOAD||row.delivery_queued!==true)return response(503,{ok:false,error:'not_confirmed'},origin);
    return response(200,{ok:true,download_url:row.download_url},origin);
  }catch{ return response(503,{ok:false,error:'not_confirmed'},origin); }
}
