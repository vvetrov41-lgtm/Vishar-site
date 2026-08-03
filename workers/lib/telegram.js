// Durable Telegram notifications use only artist-owned encrypted bindings.
import { statusClass } from './logging.js';
import { ProviderRouteError, resolveProviderBinding } from './provider-routing.js';

export function buildEnquiryNotification({referenceNumber,fileCount,clientConflict}){
  const lines=['NEW TATTOO ENQUIRY','',`Reference: ${referenceNumber}`,`Reference images: ${fileCount}`];
  if(clientConflict)lines.push('','Note: the email and phone matched two different client records. Review before replying.');
  lines.push('','Open the CRM to see the full enquiry and images.');
  return lines.join('\n');
}
export async function sendNotification(env,route,text,fetchImpl=fetch){
  let selected;
  try{selected=resolveProviderBinding(env,route);}
  catch(error){return {delivered:false,errorCode:error instanceof ProviderRouteError?error.code:'provider_route_invalid'};}
  if(selected.integrationType!=='telegram'||selected.provider!=='telegram'){
    return {delivered:false,errorCode:'telegram_provider_unsupported'};
  }
  const botToken=typeof selected.credentials.botToken==='string'?selected.credentials.botToken:'';
  const chatId=typeof selected.credentials.chatId==='string'?selected.credentials.chatId:'';
  if(!botToken||!chatId)return {delivered:false,errorCode:'provider_binding_invalid'};
  try{
    const response=await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true}),
    });
    if(!response.ok)return {delivered:false,errorCode:'telegram_rejected',statusClass:statusClass(response.status)};
    return {delivered:true};
  }catch{return {delivered:false,errorCode:'telegram_unreachable'};}
}
