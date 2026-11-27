// Dedicated sending-only Resend integration for the Vladimir cover-up guide.
// Fixed provider, artist, sender and reply address; never route from public input.
const ARTIST='a1111111-1111-4111-8111-111111111111';
const MAILBOX='info@vishartattoo.com';
const FROM='Vladimir Vishar <'+MAILBOX+'>';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validKey(key){return typeof key==='string'&&/^re_[A-Za-z0-9_-]{12,}$/.test(key);}
export function resolveGuideSender(env,artistId){
  if(artistId!==ARTIST||env?.VISHAR_ENVIRONMENT!=='production'||!validKey(env?.LEAD_MAGNET_RESEND_API_KEY))throw Error('lead_magnet_sender_unconfigured');
  return {artistId,mailboxEmail:MAILBOX,accessToken:env.LEAD_MAGNET_RESEND_API_KEY};
}
export async function sendGuideViaResend(key,message,fetchImpl=fetch){
  if(!validKey(key)||!UUID.test(message?.emailMessageId||'')||typeof message?.toEmail!=='string'||message.toEmail.length>254||!EMAIL.test(message.toEmail)||typeof message.subject!=='string'||!message.subject||message.subject.length>200||/[\r\n]/.test(message.subject)||typeof message.body!=='string'||!message.body||message.body.length>16000)throw Error('lead_magnet_message_invalid');
  // Do not retry a provider call here. The durable outbox quarantines uncertain
  // responses; provider idempotency is a second line of duplicate protection.
  const r=await fetchImpl('https://api.resend.com/emails',{
    method:'POST',redirect:'manual',
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':'cover-up-guide/'+message.emailMessageId},
    body:JSON.stringify({from:FROM,to:[message.toEmail],subject:message.subject,text:message.body,reply_to:MAILBOX}),
    signal:AbortSignal.timeout(12000),
  });
  if(!r.ok)throw Error('lead_magnet_provider_rejected');
  const result=await r.json();
  if(!UUID.test(result?.id||''))throw Error('lead_magnet_provider_receipt_invalid');
  return {providerMessageId:result.id};
}
