// Vishar-hosted public booking forms.
//
// A hosted form is a data-selected view of one allow-listed template, not an
// arbitrary HTML/form builder. The URL carries only an opaque public source id.
// The database derives Artist/source/template authority and the rendered page
// deliberately exposes none of the internal routing keys.

import { createLogger, newRequestId } from '../lib/logging.js';
import { RequestError, ConfigurationError, isMultipartRequest, jsonResponse } from '../lib/http.js';
import { createSupabaseClient, SupabaseError, toRequestError } from '../lib/supabase.js';
import { SUPPORTED_BOOKING_FORM_VERSION } from '../lib/provider-routing.js';
import { PRIVACY_NOTICE_VERSION } from '../lib/validation.js';
import { handleHostedEnquiryIntake } from './enquiries.js';

const PUBLIC_SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTED_TEMPLATE = 'tattoo-enquiry';
const HOSTED_PREFIX = '/forms/';

function safePathname(request) {
  try { return new URL(request.url).pathname; } catch { return ''; }
}

export function isHostedBookingPath(request) {
  return safePathname(request).startsWith(HOSTED_PREFIX);
}

export function readHostedBookingSourceId(request) {
  const pathname = safePathname(request);
  if (!pathname.startsWith(HOSTED_PREFIX)) return null;
  const tail = pathname.slice(HOSTED_PREFIX.length).replace(/\/$/, '');
  if (!PUBLIC_SOURCE_ID.test(tail)) return null;
  return tail.toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function unavailablePage(status = 404) {
  const title = status >= 500 ? 'Booking temporarily unavailable' : 'Booking form unavailable';
  const body = status >= 500
    ? 'This booking form cannot be loaded right now. Please try again later.'
    : 'This booking form is not active or the link is invalid.';
  return new Response(`<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#0a0a0a;color:#f5f5f7;font-family:system-ui;padding:48px"><main style="max-width:680px;margin:auto"><h1>${title}</h1><p>${body}</p></main></body></html>`, {
    status,
    headers: pageHeaders(),
  });
}

function renderHostedForm(meta, sourceId) {
  const artist = escapeHtml(meta.artist_display_name || 'Tattoo artist');
  const label = escapeHtml(meta.display_label || 'Tattoo enquiry');
  const formPath = `/forms/${encodeURIComponent(sourceId)}`;
  const privacyVersion = escapeHtml(PRIVACY_NOTICE_VERSION);

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${label} | ${artist}</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#050505;color:#f5f5f7}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#171717 0,#050505 42%);min-height:100vh}.wrap{max-width:980px;margin:0 auto;padding:56px 20px 80px}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:12px;color:#92929a}.hero{margin:10px 0 10px;font-size:clamp(36px,7vw,72px);line-height:1;letter-spacing:-.04em}.lead{max-width:700px;color:#a1a1aa;font-size:18px;line-height:1.6}.card{margin-top:38px;padding:24px;border:1px solid #262626;border-radius:28px;background:rgba(18,18,18,.9)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.span{grid-column:1/-1}label{display:block;font-size:13px;color:#c7c7cc}input,select,textarea{display:block;width:100%;margin-top:8px;border:1px solid #333;border-radius:14px;background:#101010;color:#fff;padding:13px 14px;font:inherit}textarea{min-height:150px;resize:vertical}input[type=file]{padding:10px}.required{color:#93c5fd}.privacy{margin-top:22px;padding:16px;border:1px solid #262626;border-radius:16px;color:#a1a1aa;font-size:13px;line-height:1.55}.privacy summary{cursor:pointer;color:#f5f5f7;font-weight:600}.check{display:flex;gap:10px;align-items:flex-start;margin-top:18px;color:#b7b7bf;line-height:1.45}.check input{width:auto;margin:3px 0 0}.submit{margin-top:22px;width:100%;border:0;border-radius:999px;background:#fff;color:#050505;padding:15px 20px;font-weight:700;font-size:16px;cursor:pointer}.submit:disabled{opacity:.5;cursor:wait}.status{min-height:24px;margin-top:14px;color:#a1a1aa}.hp{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important}@media(max-width:680px){.grid{grid-template-columns:1fr}.span{grid-column:auto}.wrap{padding-top:38px}.card{padding:18px;border-radius:22px}}
</style>
</head>
<body>
<main class="wrap">
<p class="eyebrow">Vishar CRM hosted booking</p>
<h1 class="hero">${artist}</h1>
<p class="lead">${label}. Send your tattoo idea, placement, approximate size and reference images. Submitting this form does not reserve an appointment.</p>
<form id="booking" class="card" enctype="multipart/form-data" novalidate>
<div class="grid">
<label>Full name <span class="required">*</span><input name="name" autocomplete="name" maxlength="120" required></label>
<label>Email <span class="required">*</span><input name="email" type="email" autocomplete="email" maxlength="320" required></label>
<label>Phone / WhatsApp <input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="80" placeholder="Include country code"></label>
<label>Instagram <input id="instagram" name="instagram" maxlength="80" placeholder="@username"></label>
<label>Preferred reply <span class="required">*</span><select id="preferredReply" name="preferredReply" required><option value="">Choose one</option><option>Email</option><option>WhatsApp</option><option>Instagram</option></select></label>
<label>Travelling from <input name="travellingFrom" maxlength="160" placeholder="City or country"></label>
<label>Project type <span class="required">*</span><select name="projectType" required><option value="">Choose one</option><option>Colour realism</option><option>Black and grey realism</option><option>Portrait</option><option>Cover-up</option><option>Large-scale project / sleeve</option><option>Not sure yet</option></select></label>
<label>Placement <span class="required">*</span><input name="placement" maxlength="160" placeholder="For example: outer forearm" required></label>
<label>Approximate size <span class="required">*</span><input name="size" maxlength="120" placeholder="Centimetres or body area" required></label>
<label>Existing tattoo / cover-up? <span class="required">*</span><select name="coverUp" required><option value="">Choose one</option><option>No</option><option>Yes</option><option>Not sure</option></select></label>
<label class="span">When would you like to start?<input name="timing" maxlength="160" placeholder="Preferred month or flexible dates"></label>
<label class="span">Your idea <span class="required">*</span><textarea name="idea" maxlength="3500" required></textarea></label>
<label class="span">Reference images <span class="required">*</span><input id="references" name="references" type="file" accept="image/jpeg,image/png,image/webp" multiple required><small>Attach 1-3 JPG, PNG or WebP images, up to 4 MB each.</small></label>
</div>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<details class="privacy"><summary>Privacy notice</summary><p>This form is operated through Vishar CRM on behalf of ${artist}. The details and images you submit are used to assess your tattoo enquiry, reply to you and provide booking-related service communications. They are not permission for marketing. Access is restricted to authorised CRM users for the relevant artist, and retention follows the workspace policy. You may ask the artist to provide, correct or delete your information where applicable.</p></details>
<label class="check"><input type="checkbox" name="privacyAcknowledged" required><span>I have read and acknowledge the privacy notice above. <span class="required">*</span></span></label>
<button id="submit" class="submit" type="submit">Send enquiry to ${artist}</button>
<p id="status" class="status" role="status" aria-live="polite"></p>
</form>
</main>
<script>
(function(){
  'use strict';
  var form=document.getElementById('booking');
  var submit=document.getElementById('submit');
  var status=document.getElementById('status');
  var files=document.getElementById('references');
  var preferred=document.getElementById('preferredReply');
  var phone=document.getElementById('phone');
  var instagram=document.getElementById('instagram');
  var keyName='vishar.hosted.enquiry.${escapeHtml(sourceId)}';
  function key(){var value='';try{value=sessionStorage.getItem(keyName)||'';}catch(e){}if(value)return value;if(!crypto||!crypto.randomUUID)throw new Error('Please update your browser and try again.');value=crypto.randomUUID();try{sessionStorage.setItem(keyName,value);}catch(e){}return value;}
  function clearKey(){try{sessionStorage.removeItem(keyName);}catch(e){}}
  function sync(){phone.required=preferred.value==='WhatsApp';instagram.required=preferred.value==='Instagram';}
  preferred.addEventListener('change',sync);sync();
  form.addEventListener('submit',async function(event){
    event.preventDefault();sync();if(!form.reportValidity())return;
    var selected=Array.from(files.files||[]);if(selected.length<1||selected.length>3||selected.some(function(file){return file.size>4*1024*1024;})){status.textContent='Please attach 1-3 reference images, up to 4 MB each.';return;}
    submit.disabled=true;submit.textContent='Sending...';status.textContent='Uploading your enquiry securely...';
    try{
      var raw=new FormData(form);var payload=new FormData();
      ['name','email','phone','instagram','preferredReply','travellingFrom','projectType','placement','size','coverUp','timing','idea','website'].forEach(function(name){payload.append(name,raw.get(name)||'');});
      var params=new URLSearchParams(location.search);
      payload.append('idempotencyKey',key());
      payload.append('privacyAcknowledged',raw.get('privacyAcknowledged')?'true':'false');
      payload.append('privacyNoticeVersion','${privacyVersion}');
      payload.append('source',location.pathname.slice(0,200));
      payload.append('landingPage',location.href.slice(0,500));
      payload.append('referrer',String(document.referrer||'').slice(0,500));
      payload.append('utmSource',(params.get('utm_source')||'').slice(0,120));
      payload.append('utmMedium',(params.get('utm_medium')||'').slice(0,120));
      payload.append('utmCampaign',(params.get('utm_campaign')||'').slice(0,160));
      payload.append('utmContent',(params.get('utm_content')||'').slice(0,160));
      payload.append('utmTerm',(params.get('utm_term')||'').slice(0,160));
      selected.forEach(function(file){payload.append('references',file,file.name);});
      var response=await fetch('${formPath}',{method:'POST',body:payload,credentials:'same-origin'});
      var result=await response.json().catch(function(){return {};});
      if(!response.ok||!result.ok){if(response.status>=400&&response.status<500)clearKey();throw new Error(result.error||'The enquiry could not be sent.');}
      clearKey();form.reset();sync();status.textContent=result.reference?'Thank you. Your enquiry is saved as '+result.reference+'.':'Thank you. Your enquiry has been saved.';submit.textContent='Enquiry sent';
    }catch(error){status.textContent=error&&error.message?error.message:'The enquiry could not be sent. Please try again.';submit.disabled=false;submit.textContent='Try again';}
  });
})();
</script>
</body>
</html>`;
}

async function resolveHostedMeta(sourceId, env, fetchImpl) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const result = await supabase.rpc('resolve_hosted_booking_source', {
    p_public_source_id: sourceId,
  });
  return Array.isArray(result) ? result[0] : result;
}

export async function handleHostedBookingRequest(request, env, { logger, fetchImpl = fetch } = {}) {
  const routeLogger = logger || createLogger(newRequestId());
  const sourceId = readHostedBookingSourceId(request);
  if (!sourceId) return unavailablePage(404);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: 'GET, POST, OPTIONS',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (request.method === 'POST') {
    if (!isMultipartRequest(request)) {
      return jsonResponse({
        ok: false,
        error: 'Please refresh this booking form and send it again.',
        code: 'multipart_required',
      }, 415, {});
    }
    return handleHostedEnquiryIntake(request, env, sourceId, {
      cors: {},
      logger: routeLogger,
      fetchImpl,
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { ...pageHeaders(), Allow: 'GET, HEAD, POST, OPTIONS' },
    });
  }

  try {
    const meta = await resolveHostedMeta(sourceId, env, fetchImpl);

    // No row means there is no active hosted source behind this id: unknown
    // link, disabled form, or an inactive artist/workspace. To a visitor those
    // are one thing, and none of them is a server fault, so the answer is the
    // same safe 404 rather than a retryable 503.
    if (!meta) {
      routeLogger.info('hosted_booking.unavailable', {
        route: 'hosted_booking',
        errorCode: 'booking_form_unavailable',
      });
      return unavailablePage(404);
    }

    // A row that exists but cannot be rendered is deploy skew, not a bad link.
    if (
      !meta.artist_display_name
      || !meta.display_label
      || meta.form_version !== SUPPORTED_BOOKING_FORM_VERSION
      || meta.form_template !== HOSTED_TEMPLATE
    ) {
      throw new ConfigurationError(
        'booking_form_version_unsupported',
        'This booking form needs to be updated.'
      );
    }

    routeLogger.info('hosted_booking.rendered', {
      route: 'hosted_booking',
      sourceMode: 'hosted',
    });

    const body = renderHostedForm(meta, sourceId);
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: pageHeaders(),
    });
  } catch (error) {
    if (
      error instanceof SupabaseError
      && error.status >= 400
      && error.status < 500
      && error.status !== 429
    ) {
      routeLogger.info('hosted_booking.unavailable', {
        route: 'hosted_booking',
        errorCode: 'booking_form_unavailable',
      });
      return unavailablePage(404);
    }

    const safe = error instanceof RequestError || error instanceof ConfigurationError
      ? error
      : toRequestError(error);
    routeLogger.error('hosted_booking.failed', {
      route: 'hosted_booking',
      errorCode: safe.code,
      status: safe.status,
    });
    return unavailablePage(safe.status >= 500 ? 503 : 404);
  }
}