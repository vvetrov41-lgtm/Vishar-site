// Canonical public booking form: /book/{artist-slug}.
//
// The slug is a human-facing alias only. GET verifies it through the backend-
// only booking-source resolver; POST injects the same server-generated selector
// into the existing durable intake path. Browser query/body fields never select
// an Artist or booking source.

import { createLogger, newRequestId } from '../lib/logging.js';
import { ConfigurationError, RequestError, isMultipartRequest, jsonResponse } from '../lib/http.js';
import { createSupabaseClient, SupabaseError, toRequestError } from '../lib/supabase.js';
import { SUPPORTED_BOOKING_FORM_VERSION } from '../lib/provider-routing.js';
import { PRIVACY_NOTICE_VERSION } from '../lib/validation.js';
import { handleEnquiryIntake } from './enquiries.js';

const PUBLIC_BOOKING_PREFIX = '/book/';
const ARTIST_SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const PUBLIC_ORIGIN = 'https://vishartattoo.com';

function safePathname(request) {
  try { return new URL(request.url).pathname; } catch { return ''; }
}

export function isPublicBookingPath(request) {
  return safePathname(request).startsWith(PUBLIC_BOOKING_PREFIX);
}

export function readPublicBookingSlug(request) {
  const pathname = safePathname(request);
  if (!pathname.startsWith(PUBLIC_BOOKING_PREFIX)) return null;
  const tail = pathname.slice(PUBLIC_BOOKING_PREFIX.length).replace(/\/$/, '');
  if (!ARTIST_SLUG.test(tail)) return null;
  return tail;
}

function titleFromSlug(slug) {
  return slug.split('-').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function pageHeaders() {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function unavailablePage(status = 404) {
  const title = status >= 500 ? 'Booking temporarily unavailable' : 'Booking form unavailable';
  const body = status >= 500
    ? 'This booking form cannot be loaded right now. Please try again later.'
    : 'This booking form is not active or the link is invalid.';
  return new Response(`<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title}</title><body style="margin:0;background:#0a0a0a;color:#f5f5f7;font-family:system-ui;padding:48px"><main style="max-width:680px;margin:auto"><h1>${title}</h1><p>${body}</p></main></body></html>`, {
    status,
    headers: pageHeaders(),
  });
}

function renderPublicForm(slug) {
  const artist = titleFromSlug(slug);
  const formPath = `/book/${slug}`;
  const privacyVersion = PRIVACY_NOTICE_VERSION;
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Booking | ${artist}</title>
<style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#050505;color:#f5f5f7}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#171717 0,#050505 42%);min-height:100vh}.wrap{max-width:980px;margin:0 auto;padding:56px 20px 80px}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:12px;color:#92929a}.hero{margin:10px 0;font-size:clamp(36px,7vw,72px);line-height:1;letter-spacing:-.04em}.lead{max-width:700px;color:#a1a1aa;font-size:18px;line-height:1.6}.card{margin-top:38px;padding:24px;border:1px solid #262626;border-radius:28px;background:rgba(18,18,18,.9)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.span{grid-column:1/-1}label{display:block;font-size:13px;color:#c7c7cc}input,select,textarea{display:block;width:100%;margin-top:8px;border:1px solid #333;border-radius:14px;background:#101010;color:#fff;padding:13px 14px;font:inherit}textarea{min-height:150px;resize:vertical}input[type=file]{padding:10px}.required{color:#93c5fd}.privacy{margin-top:22px;padding:16px;border:1px solid #262626;border-radius:16px;color:#a1a1aa;font-size:13px;line-height:1.55}.privacy summary{cursor:pointer;color:#f5f5f7;font-weight:600}.check{display:flex;gap:10px;align-items:flex-start;margin-top:18px;color:#b7b7bf;line-height:1.45}.check input{width:auto;margin:3px 0 0}.submit{margin-top:22px;width:100%;border:0;border-radius:999px;background:#fff;color:#050505;padding:15px 20px;font-weight:700;font-size:16px;cursor:pointer}.submit:disabled{opacity:.5;cursor:wait}.status{min-height:24px;margin-top:14px;color:#a1a1aa}.hp{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important}@media(max-width:680px){.grid{grid-template-columns:1fr}.span{grid-column:auto}.wrap{padding-top:38px}.card{padding:18px;border-radius:22px}}</style></head>
<body><main class="wrap"><p class="eyebrow">Tattoo booking</p><h1 class="hero">${artist}</h1><p class="lead">Send your tattoo idea, placement, approximate size and reference images. Submitting this form does not reserve an appointment.</p>
<form id="booking" class="card" enctype="multipart/form-data" novalidate><div class="grid">
<label>Full name <span class="required">*</span><input name="name" autocomplete="name" maxlength="120" required></label><label>Email <span class="required">*</span><input name="email" type="email" autocomplete="email" maxlength="320" required></label>
<label>Phone / WhatsApp <input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="80" placeholder="Include country code"></label><label>Instagram <input id="instagram" name="instagram" maxlength="80" placeholder="@username"></label>
<label>Preferred reply <span class="required">*</span><select id="preferredReply" name="preferredReply" required><option value="">Choose one</option><option>Email</option><option>WhatsApp</option><option>Instagram</option></select></label><label>Travelling from <input name="travellingFrom" maxlength="160" placeholder="City or country"></label>
<label class="span">How did you hear about ${artist}? <span class="required">*</span><select name="discoverySource" required><option value="">Choose one</option><option value="instagram">Instagram</option><option value="chatgpt">ChatGPT</option><option value="other_ai">Other AI assistant</option><option value="friend_referral">Friend / recommendation</option><option value="google">Google</option><option value="other">Other</option></select></label>
<label>Project type <span class="required">*</span><select name="projectType" required><option value="">Choose one</option><option>Colour realism</option><option>Black and grey realism</option><option>Portrait</option><option>Cover-up</option><option>Large-scale project / sleeve</option><option>Not sure yet</option></select></label><label>Placement <span class="required">*</span><input name="placement" maxlength="160" placeholder="For example: outer forearm" required></label>
<label>Approximate size <span class="required">*</span><input name="size" maxlength="120" placeholder="Centimetres or body area" required></label><label>Existing tattoo / cover-up? <span class="required">*</span><select name="coverUp" required><option value="">Choose one</option><option>No</option><option>Yes</option><option>Not sure</option></select></label>
<label class="span">When would you like to start?<input name="timing" maxlength="160" placeholder="Preferred month or flexible dates"></label><label class="span">Your idea <span class="required">*</span><textarea name="idea" maxlength="3500" required></textarea></label><label class="span">Reference images <span class="required">*</span><input id="references" name="references" type="file" accept="image/jpeg,image/png,image/webp" multiple required><small>Attach 1-3 JPG, PNG or WebP images, up to 4 MB each.</small></label></div>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div><details class="privacy"><summary>Privacy notice</summary><p>This form is operated through Vishar CRM on behalf of ${artist}. The details and images you submit are used to assess your tattoo enquiry, reply to you and provide booking-related service communications. They are not permission for marketing. Access is restricted to authorised CRM users for the relevant artist, and retention follows the workspace policy.</p></details><label class="check"><input type="checkbox" name="privacyAcknowledged" required><span>I have read and acknowledge the privacy notice above. <span class="required">*</span></span></label><button id="submit" class="submit" type="submit">Send enquiry to ${artist}</button><p id="status" class="status" role="status" aria-live="polite"></p></form></main>
<script>(function(){'use strict';var form=document.getElementById('booking'),submit=document.getElementById('submit'),status=document.getElementById('status'),files=document.getElementById('references'),preferred=document.getElementById('preferredReply'),phone=document.getElementById('phone'),instagram=document.getElementById('instagram');var keyName='vishar.public.enquiry.${slug}';function key(){var value='';try{value=sessionStorage.getItem(keyName)||'';}catch(e){}if(value)return value;if(!crypto||!crypto.randomUUID)throw new Error('Please update your browser and try again.');value=crypto.randomUUID();try{sessionStorage.setItem(keyName,value);}catch(e){}return value}function clearKey(){try{sessionStorage.removeItem(keyName)}catch(e){}}function sync(){phone.required=preferred.value==='WhatsApp';instagram.required=preferred.value==='Instagram'}preferred.addEventListener('change',sync);sync();form.addEventListener('submit',async function(event){event.preventDefault();sync();if(!form.reportValidity())return;var selected=Array.from(files.files||[]);if(selected.length<1||selected.length>3||selected.some(function(file){return file.size>4*1024*1024})){status.textContent='Please attach 1-3 reference images, up to 4 MB each.';return}submit.disabled=true;submit.textContent='Sending...';status.textContent='Uploading your enquiry securely...';try{var raw=new FormData(form),payload=new FormData();['name','email','phone','instagram','preferredReply','travellingFrom','discoverySource','projectType','placement','size','coverUp','timing','idea','website'].forEach(function(name){payload.append(name,raw.get(name)||'')});var params=new URLSearchParams(location.search);payload.append('idempotencyKey',key());payload.append('privacyAcknowledged',raw.get('privacyAcknowledged')?'true':'false');payload.append('privacyNoticeVersion','${privacyVersion}');payload.append('source',location.pathname.slice(0,200));payload.append('landingPage',location.href.slice(0,500));payload.append('referrer',String(document.referrer||'').slice(0,500));payload.append('utmSource',(params.get('utm_source')||'').slice(0,120));payload.append('utmMedium',(params.get('utm_medium')||'').slice(0,120));payload.append('utmCampaign',(params.get('utm_campaign')||'').slice(0,160));payload.append('utmContent',(params.get('utm_content')||'').slice(0,160));payload.append('utmTerm',(params.get('utm_term')||'').slice(0,160));selected.forEach(function(file){payload.append('references',file,file.name)});var response=await fetch('${formPath}',{method:'POST',body:payload,credentials:'same-origin'});var result=await response.json().catch(function(){return {}});if(!response.ok||!result.ok){if(response.status>=400&&response.status<500)clearKey();throw new Error(result.error||'The enquiry could not be sent.')}clearKey();form.reset();sync();status.textContent=result.reference?'Thank you. Your enquiry is saved as '+result.reference+'.':'Thank you. Your enquiry has been saved.';submit.textContent='Enquiry sent'}catch(error){status.textContent=error&&error.message?error.message:'The enquiry could not be sent. Please try again.';submit.disabled=false;submit.textContent='Try again'}})})();</script></body></html>`;
}

async function resolveSlug(slug, env, fetchImpl) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const result = await supabase.rpc('resolve_booking_source', {
    p_source_key: `public-slug:${slug}`,
    p_origin: PUBLIC_ORIGIN,
    p_form_version: SUPPORTED_BOOKING_FORM_VERSION,
  });
  return Array.isArray(result) ? result[0] : result;
}

function trustedIntakeRequest(request) {
  const headers = new Headers(request.headers);
  headers.set('Origin', PUBLIC_ORIGIN);
  // Constructing from the existing Request preserves its multipart body stream
  // without introducing a second stream body. This works in both Workers and
  // Node/undici and keeps browser cookies/Authorization out of routing logic.
  headers.delete('Cookie');
  headers.delete('Authorization');
  return new Request(request, { headers });
}

export async function handlePublicBookingRequest(request, env, { logger, fetchImpl = fetch } = {}) {
  const routeLogger = logger || createLogger(newRequestId());
  const slug = readPublicBookingSlug(request);
  if (!slug) return unavailablePage(404);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, POST, OPTIONS', 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'POST') {
    if (!isMultipartRequest(request)) {
      return jsonResponse({ ok: false, error: 'Please refresh this booking form and send it again.', code: 'multipart_required' }, 415, {});
    }
    return handleEnquiryIntake(
      trustedIntakeRequest(request),
      {
        ...env,
        BOOKING_SOURCE_KEY: `public-slug:${slug}`,
        BOOKING_FORM_VERSION: SUPPORTED_BOOKING_FORM_VERSION,
      },
      { cors: {}, logger: routeLogger, fetchImpl },
    );
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { ...pageHeaders(), Allow: 'GET, HEAD, POST, OPTIONS' } });
  }

  try {
    const source = await resolveSlug(slug, env, fetchImpl);
    if (!source?.artist_id || !source?.booking_source_id || source.form_version !== SUPPORTED_BOOKING_FORM_VERSION) {
      return unavailablePage(404);
    }
    const body = renderPublicForm(slug);
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: pageHeaders() });
  } catch (error) {
    if (error instanceof SupabaseError && error.status >= 400 && error.status < 500 && error.status !== 429) {
      routeLogger.info('public_booking.unavailable', { route: 'public_booking', errorCode: 'booking_form_unavailable' });
      return unavailablePage(404);
    }
    const safe = error instanceof RequestError || error instanceof ConfigurationError ? error : toRequestError(error);
    routeLogger.error('public_booking.failed', { route: 'public_booking', errorCode: safe.code, status: safe.status });
    return unavailablePage(safe.status >= 500 ? 503 : 404);
  }
}

export const __testing = Object.freeze({ PUBLIC_BOOKING_PREFIX, ARTIST_SLUG, PUBLIC_ORIGIN });