#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readConsentedTouchAttribution, recordConsentedTouchAttribution } from '../workers/lib/booking-touch-attribution.js';
const now = new Date().toISOString();
const touch = (patch={})=>({kind:'utm',path:'/booking/',referrerHost:'instagram.com',
 utmSource:'ig',utmMedium:'paid',utmCampaign:'12345',utmContent:'a',utmTerm:'',observedAt:now,...patch});
const form = (fields={})=>({get(k){return fields[k]??null}});
assert.equal(readConsentedTouchAttribution(form({firstTouch:JSON.stringify(touch()),lastTouch:JSON.stringify(touch())})),null,'no consent: ignore');
assert.equal(readConsentedTouchAttribution(form({attributionConsent:'denied',firstTouch:JSON.stringify(touch()),lastTouch:JSON.stringify(touch())})),null);
assert.equal(readConsentedTouchAttribution(form({attributionConsent:'granted',firstTouch:'{',lastTouch:JSON.stringify(touch())})),null);
assert.equal(readConsentedTouchAttribution(form({attributionConsent:'granted',firstTouch:JSON.stringify(touch({referrerHost:'https://malicious.com/?email=x'})),lastTouch:JSON.stringify(touch())})),null,'full referrer rejected');
assert.equal(readConsentedTouchAttribution(form({attributionConsent:'granted',firstTouch:JSON.stringify(touch({utmCampaign:'test@example.com'})),lastTouch:JSON.stringify(touch())})),null,'email-like campaign rejected');
assert.equal(readConsentedTouchAttribution(form({attributionConsent:'granted',firstTouch:JSON.stringify(touch({observedAt:'2000-01-01T00:00:00.000Z'})),lastTouch:JSON.stringify(touch())})),null,'expired visit rejected');
const touches=readConsentedTouchAttribution(form({attributionConsent:'granted',firstTouch:JSON.stringify(touch()),lastTouch:JSON.stringify(touch())}));
assert.equal(touches.first.utmSource,'ig');
let called=0;const logger={warn:()=>{}};
assert.equal(await recordConsentedTouchAttribution({supabase:{rpc:async (name,args)=>{called++;assert.equal(name,'service_record_enquiry_touch_attribution');assert.equal(args.p_consent_granted,true);}},enquiryId:'e',idempotencyKey:'key',touches,logger}),true);
assert.equal(called,1);
assert.equal(await recordConsentedTouchAttribution({supabase:{rpc:async()=>{throw Error('offline');}},enquiryId:'e',idempotencyKey:'key',touches,logger}),false,'optional telemetry does not fail booking');
assert.equal(await recordConsentedTouchAttribution({supabase:{rpc:async()=>{throw Error('must not call');}},enquiryId:'e',idempotencyKey:'key',touches:null,logger}),false);
const route=readFileSync(new URL('../workers/routes/enquiries.js',import.meta.url),'utf8');
const db=readFileSync(new URL('../supabase/migrations/20261013130000_booking_touch_attribution.sql',import.meta.url),'utf8');
assert.match(route,/readConsentedTouchAttribution\(form\)/);
assert.match(route,/recordConsentedTouchAttribution/);
assert.match(db,/on conflict \(enquiry_id\) do nothing/i);
assert.match(db,/crm_private\.is_service_backend/);
console.log('Booking touch attribution receiver tests passed.');
