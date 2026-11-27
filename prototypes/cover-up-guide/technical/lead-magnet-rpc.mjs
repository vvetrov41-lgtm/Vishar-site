// Service-side only: no arbitrary RPC, browser credentials or response logging.
const ORIGINS=new Set(['https://vfjexhfdbrjmuxfdvbdx.supabase.co','https://gwaliusblwrzisrwnsvs.supabase.co']);
export function createLeadMagnetRpc(env,fetchImpl=fetch){
 const origin=env?.SUPABASE_URL,secret=env?.SUPABASE_SECRET_KEY;
 if(!ORIGINS.has(origin)||typeof secret!=='string'||!secret.startsWith('sb_secret_'))throw Error('lead_magnet_backend_unconfigured');
 async function call(name,args){const r=await fetchImpl(origin+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:secret,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('lead_magnet_rpc_failed');return r.json();}
 return Object.freeze({capture:args=>call('service_capture_lead_magnet',args),claim:(worker,limit)=>call('service_claim_lead_magnet_jobs',{p_worker:worker,p_limit:limit}),authorize:(job,worker,token)=>call('service_authorize_lead_magnet_job',{p_job:job,p_worker:worker,p_token:token}),finish:(job,worker,token,outcome,provider)=>call('service_finish_lead_magnet_job',{p_job:job,p_worker:worker,p_token:token,p_outcome:outcome,p_provider_id:provider}),unsubscribe:token=>call('service_unsubscribe_lead_magnet',{p_token:token})});
}
