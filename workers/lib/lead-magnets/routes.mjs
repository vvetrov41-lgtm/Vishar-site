import { handleLeadMagnetIntake } from './intake.mjs';
import { handleLeadMagnetUnsubscribe } from './unsubscribe.mjs';
import { createLeadMagnetRpc } from './rpc.mjs';

const ROUTES = new Set(['/api/lead-magnets/cover-up-guide','/api/lead-magnets/unsubscribe']);
export function isLeadMagnetRoute(request) { return ROUTES.has(new URL(request.url).pathname); }

export async function dispatchLeadMagnet(request,env,ctx,{createDb=createLeadMagnetRpc}={}) {
  const u = new URL(request.url);
  if (u.origin!=='https://api.vishartattoo.com' || !ROUTES.has(u.pathname)) return new Response('Not found',{status:404});
  const unsubscribe=u.pathname.endsWith('/unsubscribe');
  if (env?.VISHAR_ENVIRONMENT!=='production') return new Response('Not found',{status:404});
  // Do not expose credentials or let a missing limiter degrade to an unlimited endpoint.
  const rateLimit=async ip=>{
    if(!env.PUBLIC_WRITE_RATE_LIMIT?.limit) return false;
    const key=ip.startsWith('2a06:98c0:3600:')?'worker-egress':ip;
    const result=await env.PUBLIC_WRITE_RATE_LIMIT.limit({key:'lead-magnet:'+(unsubscribe?'unsubscribe:':'intake:')+key});
    return result?.success===true;
  };
  // Instantiate the secret-backed adapter only for an actual authorized write.
  const capture=args=>createDb(env).capture(args);
  const db={unsubscribe:token=>createDb(env).unsubscribe(token)};
  const result=unsubscribe?await handleLeadMagnetUnsubscribe(request,env,{db,rateLimit}):await handleLeadMagnetIntake(request,env,{capture,rateLimit});
  // Low latency best effort; the independent scheduled drain is the durable fallback.
  if(!unsubscribe&&request.method==='POST'&&result?.status===200&&typeof ctx?.waitUntil==='function'&&typeof env.BOOKING_FALLBACK_GMAIL_SERVICE?.drainLeadMagnetOutbox==='function') {
    ctx.waitUntil(Promise.resolve().then(()=>env.BOOKING_FALLBACK_GMAIL_SERVICE.drainLeadMagnetOutbox()).catch(()=>console.error('lead_magnet.wake_failed')));
  }
  return result??new Response('Not found',{status:404});
}
