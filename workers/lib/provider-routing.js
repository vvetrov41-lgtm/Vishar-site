// Artist-owned provider binding selection.
import { ConfigurationError, RequestError } from './http.js';

export const ROUTED_INTEGRATION_TYPES = new Set(['telegram','email','calendar','whatsapp']);
export const SUPPORTED_BOOKING_FORM_VERSION='booking-v1';
const SOURCE_KEY=/^[a-z][a-z0-9-]{2,79}$/;
const PUBLIC_SLUG_SOURCE_KEY=/^public-slug:[a-z][a-z0-9-]{1,62}$/;
const PUBLIC_SOURCE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGRATION_KEY=/^[a-z][a-z0-9_-]{2,79}$/;
const PROVIDER=/^[a-z][a-z0-9_-]{1,63}$/;

export class ProviderRouteError extends Error {
  constructor(code){super('artist provider route is unavailable');this.name='ProviderRouteError';this.code=code;}
}

/**
 * The registry selector is intentionally public. It identifies a booking
 * source but grants no artist authority by itself; the backend also matches
 * the exact observed Origin before returning source_key / artist_id.
 */
export function readBookingSourcePublicId(request){
  let value='';
  try{value=(new URL(request?.url??'').searchParams.get('source')??'').trim();}catch{value='';}
  if(!value)return null;
  if(!PUBLIC_SOURCE_ID.test(value)){
    throw new RequestError('booking_source_invalid','This booking link is invalid.',400);
  }
  return value.toLowerCase();
}

/**
 * Trusted deployment/route configuration. `public-slug:<slug>` is reserved for
 * the platform-owned /book/{slug} handler: a browser never supplies this env
 * value, and the database independently re-resolves it to immutable Artist and
 * source ids before persistence.
 */
export function readTrustedBookingConfig(env){
  const sourceKey=typeof env?.BOOKING_SOURCE_KEY==='string'?env.BOOKING_SOURCE_KEY.trim():'';
  const formVersion=typeof env?.BOOKING_FORM_VERSION==='string'?env.BOOKING_FORM_VERSION.trim():'';
  const validSourceKey=SOURCE_KEY.test(sourceKey)||PUBLIC_SLUG_SOURCE_KEY.test(sourceKey);
  if(!validSourceKey||!formVersion||formVersion.length>80||/\s/.test(formVersion)){
    throw new ConfigurationError('trusted_booking_source_not_configured','The booking source is not configured.');
  }
  return {sourceKey,formVersion};
}
export function integrationTypeForOutboxKind(kind){
  if(kind==='telegram_notification')return 'telegram';
  if(kind==='transactional_email'||kind==='approved_email')return 'email';
  if(kind==='calendar_create'||kind==='calendar_update'||kind==='calendar_cancel')return 'calendar';
  if(kind==='whatsapp_message')return 'whatsapp';
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