// Artist-owned provider binding selection.
import { ConfigurationError } from './http.js';

export const ROUTED_INTEGRATION_TYPES = new Set(['telegram','email','calendar']);
const SOURCE_KEY=/^[a-z][a-z0-9-]{2,79}$/;
const INTEGRATION_KEY=/^[a-z][a-z0-9_-]{2,79}$/;
const PROVIDER=/^[a-z][a-z0-9_-]{1,63}$/;

export class ProviderRouteError extends Error {
  constructor(code){super('artist provider route is unavailable');this.name='ProviderRouteError';this.code=code;}
}

export function readTrustedBookingConfig(env){
  const sourceKey=typeof env?.BOOKING_SOURCE_KEY==='string'?env.BOOKING_SOURCE_KEY.trim():'';
  const formVersion=typeof env?.BOOKING_FORM_VERSION==='string'?env.BOOKING_FORM_VERSION.trim():'';
  if(!SOURCE_KEY.test(sourceKey)||!formVersion||formVersion.length>80||/\s/.test(formVersion)){
    throw new ConfigurationError('trusted_booking_source_not_configured','The booking source is not configured.');
  }
  return {sourceKey,formVersion};
}
export function integrationTypeForOutboxKind(kind){
  if(kind==='telegram_notification')return 'telegram';
  if(kind==='transactional_email'||kind==='approved_email')return 'email';
  if(kind==='calendar_create'||kind==='calendar_update'||kind==='calendar_cancel')return 'calendar';
  return null;
}
export function bindingNameFor(type,key){
  if(!ROUTED_INTEGRATION_TYPES.has(type)||!INTEGRATION_KEY.test(key??'')){
    throw new ProviderRouteError('provider_route_invalid');
  }
  const escaped=[...key].map(c=>c==='_'?'__':c==='-'?'_H':c.toUpperCase()).join('');
  return `ARTIST_${type.toUpperCase()}_${escaped}`;
}
export function resolveProviderBinding(env,route){
  const expected=integrationTypeForOutboxKind(route?.kind);
  if(!expected||route?.integration_type!==expected||!PROVIDER.test(route?.provider??'')){
    throw new ProviderRouteError('provider_route_invalid');
  }
  const bindingName=bindingNameFor(expected,route.integration_key);
  const raw=env?.[bindingName];
  if(typeof raw!=='string'||!raw)throw new ProviderRouteError('provider_binding_missing');
  let credentials;
  try{credentials=JSON.parse(raw);}catch{throw new ProviderRouteError('provider_binding_invalid');}
  if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)){
    throw new ProviderRouteError('provider_binding_invalid');
  }
  return {bindingName,integrationType:expected,provider:route.provider,credentials};
}
