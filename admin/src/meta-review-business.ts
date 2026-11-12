const OPERATOR = 'https://app.vishartattoo.com';
const API = 'https://crm.vishartattoo.com/api/whatsapp/meta-review/reviewer-business';
const REDIRECT = `${OPERATOR}/meta-review-business.html`;
const SUPABASE = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const STORE = 'vishar.meta-review.reviewer';
const status = document.getElementById('status')!;
const result = document.getElementById('result')!;
const signIn = document.getElementById('sign-in') as HTMLFormElement;
const meta = document.getElementById('meta') as HTMLButtonElement;
function message(s: string) { status.textContent = s; }
function pending(): { token: string; state: string; time: number } | null {
  try { return JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch { return null; }
}
async function allowed(token: string) {
  const r = await fetch(API, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!r.ok) throw new Error('Review access denied.');
}
async function complete() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return;
  const state = url.searchParams.get('state');
  const saved = pending();
  sessionStorage.removeItem(STORE);
  history.replaceState(null, '', '/meta-review-business.html');
  if (!saved || !state || state !== saved.state || Date.now() - saved.time > 600000
    || Date.now() < saved.time || error || !code || !/^[\x21-\x7e]{10,2048}$/.test(code)) {
    throw new Error('Meta login was cancelled or expired. Sign in again.');
  }
  const r = await fetch(API, { method: 'POST', headers: {
    authorization: `Bearer ${saved.token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ code }), cache: 'no-store' });
  const data = await r.json();
  if (!r.ok || data.ok !== true) throw new Error(data.error || 'Meta readback failed.');
  result.textContent = JSON.stringify({ permission: data.permission, businesses: data.businesses }, null, 2);
  message('Meta permission verified. No data was changed.');
}
signIn.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (location.origin !== OPERATOR || !KEY) throw new Error('Review page unavailable.');
    const form = new FormData(signIn);
    const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: 'POST',
      headers: { apikey: KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    const data = await r.json();
    signIn.reset();
    if (!r.ok || typeof data.access_token !== 'string') throw new Error('Sign-in failed.');
    await allowed(data.access_token);
    sessionStorage.setItem(STORE, JSON.stringify({ token: data.access_token, state: '', time: 0 }));
    signIn.hidden = true; meta.hidden = false;
    message('Review access verified. Continue with your own Meta account.');
  } catch (e) { message(e instanceof Error ? e.message : 'Sign-in failed.'); }
});
meta.addEventListener('click', () => {
  const saved = pending();
  if (!saved?.token) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  sessionStorage.setItem(STORE, JSON.stringify({ token: saved.token, state, time: Date.now() }));
  const url = new URL('https://www.facebook.com/v25.0/dialog/oauth');
  url.search = new URLSearchParams({ client_id: '1481226093843982', scope: 'business_management',
    redirect_uri: REDIRECT, response_type: 'code', state }).toString();
  location.assign(url.toString());
});
void complete().catch(e => message(e instanceof Error ? e.message : 'Review failed.'));
