// Inert transport adapter. The existing Gmail drain must not call this until
// durable transport selection and receipt reconciliation are implemented.
const ARTIST='a1111111-1111-4111-8111-111111111111';
const INTEGRATION='google_gmail_vladimir';
const MAILBOX='vvetrov41@gmail.com';
const SENDER='info@vishartattoo.com';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const RFC_ID=/^<[^\s<>]+>$/;
const MAX_RETRY_MS=23*60*60*1000;

function cleanEmail(value) {
  return typeof value==='string'&&value.length<=254&&EMAIL.test(value)?value.toLowerCase():null;
}
function validKey(value) { return typeof value==='string'&&/^re_[A-Za-z0-9_-]{12,}$/.test(value); }
function bounded(value,max) { return typeof value==='string'&&value.trim().length>0&&value.length<=max&&!value.includes('\0'); }
function validRfcId(value) { return bounded(value,998)&&RFC_ID.test(value)&&!/[\r\n]/.test(value); }

export function prepareResendRequest(env,target,message,{preparedAt,now=Date.now()}={}) {
  // Only trusted server-owned target and a previously persisted attempt may enter.
  if(env?.VISHAR_ENVIRONMENT!=='production'||env?.RESEND_CORRESPONDENCE_MODE!=='test'||
     !validKey(env?.RESEND_CORRESPONDENCE_API_KEY))throw Error('resend_correspondence_disabled');
  if(target?.artist_id!==ARTIST||target?.integration_key!==INTEGRATION||
     target?.mailbox_email!==MAILBOX||target?.delivery_allowed!==true)
    throw Error('resend_correspondence_scope_invalid');
  const to=cleanEmail(message?.toEmail);
  if(!to||to!==MAILBOX||to!==cleanEmail(target.client_email))
    throw Error('resend_correspondence_test_recipient_invalid');
  if(!UUID.test(message?.emailMessageId||'')||message.emailMessageId!==target.email_message_id||
     !bounded(message.subject,998)||/[\r\n]/.test(message.subject)||!bounded(message.body,8000)||
     (message.htmlBody!=null&&!bounded(message.htmlBody,30000)))
    throw Error('resend_correspondence_message_invalid');
  // Resend retains idempotency keys for 24 hours; stop conservatively before expiry.
  if(!Number.isFinite(preparedAt)||!Number.isFinite(now)||preparedAt>now||now-preparedAt>=MAX_RETRY_MS)
    throw Error('resend_correspondence_attempt_expired');
  const headers={'X-Vishar-Email-ID':message.emailMessageId.toLowerCase()};
  if(message.inReplyTo!=null) {
    if(!validRfcId(message.inReplyTo))throw Error('resend_correspondence_headers_invalid');
    headers['In-Reply-To']=message.inReplyTo;
  }
  if(message.references!=null) {
    if(!bounded(message.references,4096)||/[\r\n]/.test(message.references)||
      !message.references.split(/ +/).every(validRfcId))
      throw Error('resend_correspondence_headers_invalid');
    headers.References=message.references;
  }
  return {
    key:'crm-email/'+message.emailMessageId.toLowerCase(),
    payload:{from:'Vladimir Vishar <'+SENDER+'>',to:[to],subject:message.subject,text:message.body,
      ...(message.htmlBody!=null?{html:message.htmlBody}:{}),reply_to:SENDER,headers}
  };
}

// Never retry in the adapter. An uncertain result must be persisted and reconciled;
// no fallback to Gmail. Return a Resend receipt, never fabricate a Gmail ID.
export async function sendResendCorrespondence(env,target,message,options={}) {
  const {key,payload}=prepareResendRequest(env,target,message,options);
  const fetchImpl=options.fetchImpl||fetch;
  let response;
  try {
    response=await fetchImpl('https://api.resend.com/emails',{method:'POST',redirect:'manual',
      headers:{Authorization:'Bearer '+env.RESEND_CORRESPONDENCE_API_KEY,'Content-Type':'application/json','Idempotency-Key':key},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
  } catch { throw Error('resend_correspondence_uncertain'); }
  if(!response.ok) {
    if((response.status>=300&&response.status<400)||response.status===409||response.status>=500)throw Error('resend_correspondence_uncertain');
    if(response.status===429)throw Error('resend_correspondence_rate_limited');
    throw Error('resend_correspondence_rejected');
  }
  let data;
  try {data=await response.json();}catch{throw Error('resend_correspondence_uncertain');}
  if(!UUID.test(data?.id||''))throw Error('resend_correspondence_uncertain');
  return {provider:'resend',providerMessageId:data.id,acceptance:'accepted'};
}
