// Optional booking attribution. Read only after an explicit analytics-consent marker.
// This must remain outside the canonical intake fingerprint and never block a booking.
const FIELD_LENGTHS = { utmSource:120, utmMedium:120, utmCampaign:160, utmContent:160, utmTerm:160 };
const SAFE_TEXT = /^[a-zA-Z0-9 _.-]*$/;
const SAFE_PATH = /^\/[a-zA-Z0-9/%_.-]{0,199}$/;
const SAFE_HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/;
const MAX_AGE_MS = 30 * 86400 * 1000;
function decodeTouch(raw) {
  if (typeof raw !== 'string' || raw.length > 2200 || raw.length < 2) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const expected = ['kind','path','referrerHost','utmSource','utmMedium','utmCampaign','utmContent','utmTerm','observedAt'];
  if (Object.keys(data).length !== expected.length || expected.some(key => typeof data[key] !== 'string')) return null;
  if (!['utm','referral','direct'].includes(data.kind) || !SAFE_PATH.test(data.path)
      || data.referrerHost.length > 120 || (data.referrerHost && !SAFE_HOST.test(data.referrerHost))
      || Object.entries(FIELD_LENGTHS).some(([k,n]) => data[k].length > n || !SAFE_TEXT.test(data[k]))) return null;
  const when = Date.parse(data.observedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.observedAt)
      || !Number.isFinite(when) || when > Date.now()+60000 || Date.now()-when > MAX_AGE_MS) return null;
  if (data.kind === 'direct' && (data.referrerHost || Object.keys(FIELD_LENGTHS).some(k=>data[k]))) return null;
  if (data.kind === 'referral' && (!data.referrerHost || Object.keys(FIELD_LENGTHS).some(k=>data[k]))) return null;
  if (data.kind === 'utm' && !Object.keys(FIELD_LENGTHS).some(k=>data[k])) return null;
  return data;
}
export function readConsentedTouchAttribution(form) {
  if (form.get('attributionConsent') !== 'granted') return null;
  const first = decodeTouch(form.get('firstTouch'));
  const last = decodeTouch(form.get('lastTouch'));
  if (!first || !last || Date.parse(first.observedAt) > Date.parse(last.observedAt)) return null;
  return { first, last };
}
export async function recordConsentedTouchAttribution({supabase,enquiryId,idempotencyKey,touches,logger}) {
  if (!touches) return false;
  try {
    await supabase.rpc('service_record_enquiry_touch_attribution',{
      p_enquiry_id:enquiryId, p_idempotency_key:idempotencyKey,
      p_consent_granted:true, p_first_touch:touches.first, p_last_touch:touches.last
    });
    return true;
  } catch {
    logger?.warn?.('enquiry.touch_attribution_unavailable', {route:'enquiries',enquiryId,errorCode:'touch_attribution_unavailable'});
    return false;
  }
}
