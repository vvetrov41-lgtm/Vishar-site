import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`${label}: expected exactly one match`);
  return source.replace(before, after);
}

{
  const file = 'workers/lib/google-gmail.js';
  let source = fs.readFileSync(file, 'utf8');
  source = replaceOnce(source,
`  if (!parsed || parsed.v !== 1 || !safeEmail(parsed.mailbox_email) || !safeProviderId(parsed.artist_id?.replace(/-/g, '_') || '')) {
    // artist_id is validated separately because UUIDs contain hyphens and are not provider ids.
  }
  if (!parsed || parsed.v !== 1 || typeof parsed.refresh_token !== 'string' || parsed.refresh_token.length < 8) {
    throw new Error('gmail_token_envelope_invalid');
  }`,
`  if (
    !parsed
    || parsed.v !== 1
    || typeof parsed.artist_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.artist_id)
    || typeof parsed.integration_key !== 'string'
    || !/^google_gmail_[a-z0-9_-]{2,60}$/.test(parsed.integration_key)
    || !safeEmail(parsed.mailbox_email)
    || typeof parsed.refresh_token !== 'string'
    || parsed.refresh_token.length < 8
    || parsed.refresh_token.length > 8192
    || !hasRequiredScopes(parsed.scope)
  ) {
    throw new Error('gmail_token_envelope_invalid');
  }`,
  'encrypted token validation');
  fs.writeFileSync(file, source);
}

{
  const file = 'workers/gmail-production.js';
  let source = fs.readFileSync(file, 'utf8');
  source = replaceOnce(source,
`const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const REDIRECT_URI = 'https://gmail.vishartattoo.com/oauth/google/callback';`,
`const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const GMAIL_PUBLIC_HOST = 'gmail.vishartattoo.com';
const GPT_OPERATIONS_HOST = 'gpt-operations.vishartattoo.com';
const REDIRECT_URI = 'https://gmail.vishartattoo.com/oauth/google/callback';`,
  'production hosts');
  source = replaceOnce(source,
`async function startOAuth(url, env) {
  if (env?.GMAIL_OAUTH_ENABLED !== 'true')`,
`async function startOAuth(url, env) {
  if (url.hostname !== GMAIL_PUBLIC_HOST) return null;
  if (env?.GMAIL_OAUTH_ENABLED !== 'true')`,
  'OAuth start host');
  source = replaceOnce(source,
`async function oauthCallback(url, env, fetchImpl) {
  if (url.pathname.replace(/\\/+$/, '') !== '/oauth/google/callback') return null;`,
`async function oauthCallback(url, env, fetchImpl) {
  if (url.hostname !== GMAIL_PUBLIC_HOST) return null;
  if (url.pathname.replace(/\\/+$/, '') !== '/oauth/google/callback') return null;`,
  'OAuth callback host');
  source = replaceOnce(source,
`async function handleGptAction(request, url, env, fetchImpl) {
  const history =`,
`async function handleGptAction(request, url, env, fetchImpl) {
  if (url.hostname !== GPT_OPERATIONS_HOST) return null;
  const history =`,
  'GPT service-binding host');
  fs.writeFileSync(file, source);
}
