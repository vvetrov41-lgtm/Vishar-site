// Fixed-target, first-time token provisioning only. Default mode is read-only.
// Credentials are carried in memory and headers, never URLs, logs or files.
import { pathToFileURL } from 'node:url';

export const TARGET = Object.freeze({
  account: '787a19ac4890ba7a114d44cabf085588',
  worker: 'vishar-telegram-drain-production',
  secret: 'META_ADS_VLADIMIR_ACCESS_TOKEN',
  pixel: '2163876287819749',
  systemUser: '61593708522729',
});
const REQUIRED = ['ARTIST_TELEGRAM_KRISTINA_HPRODUCTION', 'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION', 'SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const names = rows => {
  if (!Array.isArray(rows) || rows.some(r => typeof r?.name !== 'string')) throw new Error('Secret-name inventory is invalid');
  return rows.map(r => r.name).sort();
};
const nonSecretSettings = settings => ({
  ...settings,
  bindings: (settings?.bindings || []).filter(b => !['secret_text', 'secret_key'].includes(b.type))
    .sort((a, b) => a.name.localeCompare(b.name)),
});

export async function provisionMetaToken({ env, provision = false, fetchImpl = fetch }) {
  if (env.CLOUDFLARE_ACCOUNT_ID !== TARGET.account) throw new Error('Cloudflare account does not match the approved production account');
  const cfToken = env.CLOUDFLARE_API_TOKEN;
  const metaToken = env.META_ADS_VLADIMIR_ACCESS_TOKEN;
  if (!cfToken || !metaToken || /\s/.test(metaToken)) throw new Error('Required credential is missing or malformed');
  const base = `https://api.cloudflare.com/client/v4/accounts/${TARGET.account}/workers/scripts/${TARGET.worker}`;
  const read = async (url, token, method = 'GET', body) => {
    let response, payload;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      payload = await response.json();
    } catch { throw new Error(`Provider ${method} request failed; details suppressed`); }
    if (!response.ok || payload?.error || payload?.success === false) {
      throw new Error(`Provider ${method} request rejected (HTTP ${response.status}); details suppressed`);
    }
    return payload;
  };
  const cf = async (path, method = 'GET', body) => {
    const payload = await read(`${base}${path}`, cfToken, method, body);
    if (payload?.success !== true) throw new Error('Cloudflare response did not confirm success');
    return payload.result;
  };
  const graph = path => read(`https://graph.facebook.com/v26.0/${path}`, metaToken);
  const me = await graph('me?fields=id');
  if (me?.id !== TARGET.systemUser) throw new Error('Token system user does not match the approved user');
  const permissions = await graph('me/permissions');
  if (!permissions?.data?.some(p => p.permission === 'ads_read' && p.status === 'granted')) {
    throw new Error('Token does not grant the approved ads_read permission');
  }
  const pixel = await graph(`${TARGET.pixel}?fields=id`);
  if (pixel?.id !== TARGET.pixel) throw new Error('Token cannot read the approved Pixel');
  const before = await cf('/settings');
  const vars = Object.fromEntries((before?.bindings || []).filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
  if (vars.VISHAR_ENVIRONMENT !== 'production' || vars.SUPABASE_URL !== 'https://vfjexhfdbrjmuxfdvbdx.supabase.co') {
    throw new Error('Worker environment or backend does not match production');
  }
  if (vars.META_ADS_DRAIN_ENABLED && vars.META_ADS_DRAIN_ENABLED !== 'false') throw new Error('Provisioning requires the Meta drain to remain off');
  const beforeNames = names(await cf('/secrets'));
  if (beforeNames.includes(TARGET.secret)) throw new Error('Token already exists; first-time provisioning refuses to rotate it');
  if (REQUIRED.some(n => !beforeNames.includes(n))) throw new Error('An existing production fallback secret is missing');
  const summary = { worker: TARGET.worker, pixel: TARGET.pixel, system_user: TARGET.systemUser, mode: provision ? 'provision' : 'validate', token_read_access_verified: true, capi_delivery_verified: false, drain_enabled: false };
  if (!provision) return summary;
  // One-key RFC7396 merge patch. No omitted secret is replaced; no null/delete values.
  // https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/
  await cf('/secrets-bulk', 'PATCH', { secrets: { [TARGET.secret]: { name: TARGET.secret, type: 'secret_text', text: metaToken } } });
  const afterNames = names(await cf('/secrets'));
  if (stable(afterNames) !== stable([...beforeNames, TARGET.secret].sort())) throw new Error('Post-provision secret-name inventory differs from the approved addition');
  const after = await cf('/settings');
  if (stable(nonSecretSettings(before)) !== stable(nonSecretSettings(after))) throw new Error('Post-provision non-secret settings changed unexpectedly');
  return { ...summary, secret_name: TARGET.secret, secret_present: true, existing_secret_names_preserved: true, non_secret_settings_preserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--provision') || args.length > 1) throw new Error('Only the explicit --provision option is accepted');
    console.log(JSON.stringify(await provisionMetaToken({ env: process.env, provision: args.includes('--provision') })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
