// Isolated adapter: does not send unless explicitly enabled and wired to reviewed
// server-only database and artist-bound mail dependencies. Never expose to browsers.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STEPS=new Set([0,3,7,14]);
const DOWNLOAD=/^https:\/\/vishartattoo\.com\/assets\/lead-magnets\/cover-up-guide-v[0-9]+\.pdf$/;
const OPT_OUT='https://api.vishartattoo.com/api/lead-magnets/unsubscribe';
function render(text, values){return text.replace(/\{\{([a-z_]+)\}\}/g,(_m,k)=>{if(!Object.hasOwn(values,k))throw Error('template_field_unknown');return values[k]});}
function check(job, id){return job && job.job_id===id && UUID.test(job.artist_id) && job.magnet_slug==='cover-up-guide' && STEPS.has(job.step) && typeof job.first_name==='string' && job.first_name.length>0 && job.first_name.length<=80 && !/[\x00-\x1f\x7f]/.test(job.first_name) && typeof job.email==='string' && job.email.length<=254 && MAIL.test(job.email) && typeof job.download_url==='string' && DOWNLOAD.test(job.download_url) && job.download_url.endsWith('/cover-up-guide-'+job.asset_version+'.pdf') && (job.step===0 || UUID.test(job.unsubscribe_token));}
function fingerprint(j){return JSON.stringify([j.job_id,j.artist_id,j.magnet_slug,j.email,j.first_name,j.step,j.asset_version,j.download_url,j.unsubscribe_token]);}
export function buildLeadMagnetMessage(job,sequence){
 if(!check(job,job?.job_id)||sequence?.campaign!=='cover-up-guide')throw Error('job_invalid');
 const tpl=sequence.schedule?.find(s=>s.step===job.step);
 if(!tpl||tpl.category!==(job.step===0?'requested_delivery':'marketing_opt_in_only'))throw Error('template_invalid');
 const values={first_name:job.first_name,download_url:job.download_url,unsubscribe_url:job.step===0?'':OPT_OUT+'?t='+job.unsubscribe_token};
 if(job.step===0 && /\{\{unsubscribe_url\}\}/.test(tpl.body))throw Error('service_template_invalid');
 if(job.step>0&&!tpl.body.includes('{{unsubscribe_url}}'))throw Error('unsubscribe_missing');
 return {toEmail:job.email,subject:render(tpl.subject,values),body:render(tpl.body,values),emailMessageId:job.job_id};
}
export async function drainLeadMagnetJobs(env,{db,resolveSender,send,sequence,workerId='lead_magnet_worker',limit=5}={}){
 if(env?.LEAD_MAGNET_DELIVERY_ENABLED!=='true')return {skipped:true,processed:0,results:[]};
 if(!db||typeof resolveSender!=='function'||typeof send!=='function'||!sequence||!/^[-a-z0-9_]{3,128}$/.test(workerId))throw Error('delivery_dependencies_missing');
 const claims=await db.claim(workerId,Math.min(20,Math.max(1,Math.trunc(Number(limit)||5))));
 if(!Array.isArray(claims))throw Error('claim_invalid');
 const results=[];
 for(const claim of claims){
  const id=claim?.job_id,token=claim?.lease_token;
  if(!UUID.test(id)||!UUID.test(token))throw Error('claim_shape_invalid');
  let outcome='retry_before_send',providerId=null;
  try{
   const first=await db.authorize(id,workerId,token);
   if(!first)outcome='cancelled';
   else{
    if(!check(first,id))throw Error('job_shape');
    // Resolve provider account independently against the exact artist in the job.
    const sender=await resolveSender(first.artist_id);
    if(sender?.artistId!==first.artist_id||typeof sender.mailboxEmail!=='string'||!MAIL.test(sender.mailboxEmail)||!sender.accessToken)throw Error('sender_binding');
    const live=await db.authorize(id,workerId,token);
    if(!live||!check(live,id)||fingerprint(first)!==fingerprint(live))outcome='cancelled';
    else{
     const message=buildLeadMagnetMessage(live,sequence);
     outcome='uncertain'; // After this boundary a provider may have accepted the send.
     const receipt=await send(sender.accessToken,message);
     if(typeof receipt?.providerMessageId!=='string'||!/^[-A-Za-z0-9_]{1,200}$/.test(receipt.providerMessageId))throw Error('receipt_unknown');
     providerId=receipt.providerMessageId;outcome='sent';
    }
   }
  }catch{/* No recipient, token, provider payload or exception content in logs. */}
  try{
   const acknowledged=await db.finish(id,workerId,token,outcome,providerId);
   results.push({job_id:id,outcome:acknowledged===true?outcome:'acknowledgement_unknown'});
  }catch{results.push({job_id:id,outcome:'acknowledgement_unknown'});}
 }
 return {skipped:false,processed:results.length,results};
}
