// Generates the ephemeral production Wrangler config for the Instagram
// connector.
//
// The tracked template is deliberately inert: every capability is off, no KV
// namespace is bound and no schedule exists. That is what makes it safe to
// review and safe to compile in ordinary CI. Turning it into something that can
// actually talk to Meta is a release decision, so it happens here, from
// explicitly supplied values, and the result is written to a temporary file
// that the deploy workflow removes.
//
// Nothing secret passes through this script. KV namespace ids, the Instagram
// app id and the Supabase publishable key are non-secret identifiers; the app
// secret, the token encryption key, the webhook verify token and the Supabase
// service key remain encrypted Worker secrets that are never read here.

import fs from 'node:fs';
import path from 'node:path';

const source = new URL('../wrangler.instagram.production.toml', import.meta.url);
const outputArg = process.argv[2];
if (!outputArg) throw new Error('output path is required');

const output = path.resolve(outputArg);
const sourcePath = path.resolve(source.pathname);
if (output === sourcePath) throw new Error('refusing to overwrite the tracked production template');

let text = fs.readFileSync(source, 'utf8');

const required = [
  'name = "vishar-instagram-production"',
  'main = "workers/instagram-production-entry.js"',
  'workers_dev = false',
  'preview_urls = false',
  'VISHAR_ENVIRONMENT = "production"',
  'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"',
  'pattern = "instagram.vishartattoo.com"',
  'INSTAGRAM_OAUTH_ENABLED = "false"',
  'INSTAGRAM_DRAIN_ENABLED = "false"',
  'INSTAGRAM_ENRICHMENT_ENABLED = "false"',
];
for (const needle of required) {
  if (!text.includes(needle)) throw new Error(`production template is missing ${needle}`);
}

// Comments may legitimately name a forbidden token while explaining why it is
// absent, so the check runs against directives only.
const directives = text
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');

const forbidden = [
  'gwaliusblwrzisrwnsvs',
  'vishar-instagram-staging',
  'INSTAGRAM_APP_SECRET',
  'INSTAGRAM_TOKEN_ENCRYPTION_KEY',
  'INSTAGRAM_WEBHOOK_VERIFY_TOKEN',
  'SUPABASE_SECRET_KEY',
];
for (const needle of forbidden) {
  if (directives.includes(needle)) {
    throw new Error(`production template contains a forbidden secret or staging token: ${needle}`);
  }
}
if (/^\s*\[triggers\]\s*$/m.test(text) || /^\s*crons\s*=/m.test(text)) {
  throw new Error('tracked production template must remain unscheduled');
}
if (/^\s*\[\[kv_namespaces\]\]\s*$/m.test(text)) {
  throw new Error('tracked production template must not bind a KV namespace');
}

const KV_ID = /^[0-9a-f]{32}$/;
function requireEnv(name, pattern, label) {
  const value = String(process.env[name] || '').trim();
  if (!pattern.test(value)) throw new Error(`${name} must be ${label}`);
  return value;
}

const stateNamespace = requireEnv('INSTAGRAM_OAUTH_STATE_ID', KV_ID, 'a 32 character KV namespace id');
const tokensNamespace = requireEnv('INSTAGRAM_OAUTH_TOKENS_ID', KV_ID, 'a 32 character KV namespace id');
if (stateNamespace === tokensNamespace) {
  // Short-lived CSRF state and long-lived encrypted tokens must not share a
  // namespace: a state-listing bug would otherwise enumerate token keys.
  throw new Error('OAuth state and token KV namespaces must be different');
}

const appId = requireEnv('INSTAGRAM_APP_ID', /^[0-9A-Za-z_-]{8,64}$/, 'the Instagram app id');
const publishableKey = requireEnv(
  'SUPABASE_PUBLISHABLE_KEY',
  /^sb_publishable_[A-Za-z0-9_-]{16,512}$/,
  'the production Supabase publishable key',
);

// Each capability is enabled explicitly. A release may activate onboarding
// without activating the drain, which is exactly the order the Meta rollout
// needs: connect the accounts first, start sending afterwards.
const flag = (name, envName) => {
  const value = String(process.env[envName] || 'false').trim();
  if (value !== 'true' && value !== 'false') throw new Error(`${envName} must be true or false`);
  text = text.replace(`${name} = "false"`, `${name} = "${value}"`);
  return value === 'true';
};

const oauthEnabled = flag('INSTAGRAM_OAUTH_ENABLED', 'ENABLE_INSTAGRAM_OAUTH');
const drainEnabled = flag('INSTAGRAM_DRAIN_ENABLED', 'ENABLE_INSTAGRAM_DRAIN');
flag('INSTAGRAM_ENRICHMENT_ENABLED', 'ENABLE_INSTAGRAM_ENRICHMENT');

text += `\nINSTAGRAM_APP_ID = "${appId}"\n`;
text += `SUPABASE_PUBLISHABLE_KEY = "${publishableKey}"\n`;

// An optional hard pin per artist. Once the owner knows an account id, a
// callback returning any other account is refused.
for (const [envName, varName] of [
  ['INSTAGRAM_ACCOUNT_VLADIMIR', 'INSTAGRAM_ACCOUNT_VLADIMIR'],
  ['INSTAGRAM_ACCOUNT_KRISTINA', 'INSTAGRAM_ACCOUNT_KRISTINA'],
]) {
  const value = String(process.env[envName] || '').trim();
  if (!value) continue;
  if (!/^[0-9]{5,40}$/.test(value)) throw new Error(`${envName} must be an Instagram professional account id`);
  text += `${varName} = "${value}"\n`;
}

text += `\n[[kv_namespaces]]\nbinding = "INSTAGRAM_OAUTH_STATE"\nid = "${stateNamespace}"\n`;
text += `\n[[kv_namespaces]]\nbinding = "INSTAGRAM_OAUTH_TOKENS"\nid = "${tokensNamespace}"\n`;

// The schedule exists only when there is scheduled work to do.
if (drainEnabled || String(process.env.ENABLE_INSTAGRAM_ENRICHMENT || '') === 'true') {
  text += '\n[triggers]\ncrons = ["*/5 * * * *"]\n';
}

if (drainEnabled && !oauthEnabled) {
  // Draining without onboarding would mean a queue that can never obtain a
  // token, so the release order is enforced rather than documented.
  throw new Error('the Instagram drain cannot be enabled before onboarding');
}

fs.writeFileSync(output, text, { mode: 0o600 });
console.log(`instagram production deploy config written to ${output}`);
