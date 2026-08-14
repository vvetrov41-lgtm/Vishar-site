// Durable Telegram notifications use only artist-owned encrypted bindings.
import { statusClass } from './logging.js';
import { ProviderRouteError, resolveProviderBinding } from './provider-routing.js';

export function buildEnquiryNotification({referenceNumber,fileCount,clientConflict}){
  const lines=['NEW TATTOO ENQUIRY','',`Reference: ${referenceNumber}`,`Reference images: ${fileCount}`];
  if(clientConflict)lines.push('','Note: the email and phone matched two different client records. Review before replying.');
  lines.push('','Open the CRM to see the full enquiry and images.');
  return lines.join('\n');
}
function diagnosticError(operation,status){
  const statusGroup=statusClass(status);
  if(status===401)return {reachable:false,errorCode:'telegram_bot_token_invalid',statusClass:statusGroup};
  if(operation==='getChat'&&status===400){
    return {reachable:false,errorCode:'telegram_destination_unavailable',statusClass:statusGroup};
  }
  if(operation==='getChat'&&status===403){
    return {reachable:false,errorCode:'telegram_destination_forbidden',statusClass:statusGroup};
  }
  if(status===429||status>=500){
    return {reachable:false,errorCode:'telegram_provider_unavailable',statusClass:statusGroup};
  }
  if(operation==='getMe'){
    return {reachable:false,errorCode:'telegram_bot_preflight_rejected',statusClass:statusGroup};
  }
  return {reachable:false,errorCode:'telegram_destination_rejected',statusClass:statusGroup};
}
export async function checkTelegramDestination(env,route,fetchImpl=fetch){
  let selected;
  try{selected=resolveProviderBinding(env,route);}
  catch(error){return {reachable:false,errorCode:error instanceof ProviderRouteError?error.code:'provider_route_invalid'};}
  if(selected.integrationType!=='telegram'||selected.provider!=='telegram'){
    return {reachable:false,errorCode:'telegram_provider_unsupported'};
  }
  const botToken=typeof selected.credentials.botToken==='string'?selected.credentials.botToken:'';
  const chatId=typeof selected.credentials.chatId==='string'?selected.credentials.chatId:'';
  if(!botToken||!chatId)return {reachable:false,errorCode:'provider_binding_invalid'};
  try{
    const base=`https://api.telegram.org/bot${botToken}`;
    const botResponse=await fetchImpl(`${base}/getMe`,{method:'GET'});
    if(!botResponse.ok)return diagnosticError('getMe',botResponse.status);
    const botBody=await botResponse.json().catch(()=>null);
    if(botBody?.ok!==true||!Number.isSafeInteger(botBody?.result?.id)){
      return {reachable:false,errorCode:'telegram_bot_response_invalid'};
    }
    const chatResponse=await fetchImpl(`${base}/getChat`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId}),
    });
    if(!chatResponse.ok)return diagnosticError('getChat',chatResponse.status);
    const chatBody=await chatResponse.json().catch(()=>null);
    if(chatBody?.ok!==true||String(chatBody?.result?.id??'')!==String(chatId)){
      return {reachable:false,errorCode:'telegram_destination_response_invalid'};
    }
    return {reachable:true};
  }catch{return {reachable:false,errorCode:'telegram_unreachable'};}
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
