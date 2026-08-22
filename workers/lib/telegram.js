// Durable Telegram notifications prefer the shared-bot destination registry
// once it is configured, while legacy artist-owned bindings remain the rollout
// fallback until production equivalence is proven.
import { statusClass } from './logging.js';
import { ProviderRouteError, resolveProviderBinding } from './provider-routing.js';

const CHAT_ID = /^-?[0-9]{1,20}$/;
const SHARED_BOT_TOKEN = /^[A-Za-z0-9:_-]{20,256}$/;

export function buildEnquiryNotification({referenceNumber,fileCount,clientConflict}){
  const lines=['NEW TATTOO ENQUIRY','',`Reference: ${referenceNumber}`,`Reference images: ${fileCount}`];
  if(clientConflict)lines.push('','Note: the email and phone matched two different client records. Review before replying.');
  lines.push('','Open the CRM to see the full enquiry and images.');
  return lines.join('\n');
}

export function buildPersonalNotification({title,body}){
  const safeTitle=typeof title==='string'?title.trim():'';
  const safeBody=typeof body==='string'?body.trim():'';
  if(!safeTitle)return null;
  return safeBody?`${safeTitle}\n\n${safeBody}`:safeTitle;
}

export function sharedTelegramBotToken(env){
  const value=typeof env?.TELEGRAM_BOT_TOKEN==='string'?env.TELEGRAM_BOT_TOKEN.trim():'';
  return SHARED_BOT_TOKEN.test(value)?value:null;
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

async function sendTelegramMessage(botToken,chatId,text,fetchImpl=fetch){
  // Legacy encrypted bindings historically accepted any non-empty provider
  // token. Keep that contract here; only the new shared env binding is subject
  // to SHARED_BOT_TOKEN validation in sharedTelegramBotToken().
  if(
    typeof botToken!=='string'||!botToken||botToken.length>256||/\s/.test(botToken)
    || typeof chatId!=='string'||!chatId
    || typeof text!=='string'||!text
  ){
    return {delivered:false,errorCode:'telegram_destination_invalid'};
  }
  try{
    const response=await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:String(chatId),text,disable_web_page_preview:true}),
    });
    if(!response.ok)return {delivered:false,errorCode:'telegram_rejected',statusClass:statusClass(response.status)};
    return {delivered:true};
  }catch{return {delivered:false,errorCode:'telegram_unreachable'};}
}

export async function sendSharedTelegramNotification(env,chatId,text,fetchImpl=fetch){
  const botToken=sharedTelegramBotToken(env);
  if(!botToken)return {delivered:false,errorCode:'telegram_shared_bot_not_configured'};
  if(!CHAT_ID.test(String(chatId??'')))return {delivered:false,errorCode:'telegram_destination_invalid'};
  return sendTelegramMessage(botToken,String(chatId),text,fetchImpl);
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
  return sendTelegramMessage(botToken,chatId,text,fetchImpl);
}

export const __testing={CHAT_ID,SHARED_BOT_TOKEN,sendTelegramMessage};
