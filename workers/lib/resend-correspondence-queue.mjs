import {prepareResendRequest,sendResendCorrespondence} from './resend-correspondence.mjs';

// Explicit opt-in, owner address, fresh human-approved standalone test only.
// Selection is also validated under a locked DB lease; never infer from subject alone.
export function isOwnerResendTest(env,job,target) {
  return env?.VISHAR_ENVIRONMENT==='production'&&env?.RESEND_CORRESPONDENCE_MODE==='test'
    &&target?.artist_id==='a1111111-1111-4111-8111-111111111111'
    &&target?.integration_key==='google_gmail_vladimir'
    &&target?.mailbox_email==='vvetrov41@gmail.com'&&target?.client_email==='vvetrov41@gmail.com'
    &&target?.delivery_allowed===true&&job?.attempt_count===0&&!job?.thread_context_id
    &&typeof job?.subject==='string'&&job.subject.startsWith('[Resend owner test] ')
    &&target.configuration?.review_email!==true&&target.configuration?.booking_card_reply_in_existing_thread!==true;
}

export async function dispatchOwnerResendTest(job,env,db,target,workerId,fetchImpl) {
  if(!isOwnerResendTest(env,job,target))throw Error('resend_correspondence_scope_invalid');
  const message={toEmail:target.client_email,emailMessageId:job.email_message_id,subject:job.subject,body:job.body,htmlBody:job.html_body??null};
  // Validate immutable payload before reservation; no provider call here.
  const now=Date.now();
  const {payload}=prepareResendRequest(env,target,message,{preparedAt:now,now});
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))),x=>x.toString(16).padStart(2,'0')).join('');
  const reserved=await db.backendRpc('service_reserve_resend_correspondence',{p_outbox_id:job.outbox_id,p_worker_id:workerId,p_payload_sha256:hash});
  if(reserved?.reserved!==true||reserved.email_message_id!==job.email_message_id)throw Error('resend_correspondence_reservation_denied');
  let state='uncertain',providerId=null;
  try{
    const preparedAt=Date.parse(reserved.prepared_at);
    const sent=await sendResendCorrespondence(env,target,message,{preparedAt,fetchImpl});
    providerId=sent.providerMessageId;state='accepted';
  }catch(error){
    if(['resend_correspondence_rejected','resend_correspondence_rate_limited'].includes(error?.message))state='rejected';
  }
  const receipt=await db.backendRpc('service_record_resend_correspondence',{p_outbox_id:job.outbox_id,p_worker_id:workerId,p_payload_sha256:hash,p_state:state,p_provider_message_id:providerId});
  if(receipt?.state!==state)throw Error('resend_correspondence_receipt_unconfirmed');
  return {outbox_id:job.outbox_id,outcome:state==='accepted'?'sent':state,error_code:state==='accepted'?undefined:'resend_correspondence_'+state};
}
