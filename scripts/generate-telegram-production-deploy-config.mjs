import fs from 'node:fs';
import path from 'node:path';

const source = new URL('../wrangler.telegram-drain.production.toml', import.meta.url);
const outputArg = process.argv[2];
if (!outputArg) throw new Error('output path is required');

const output = path.resolve(outputArg);
const sourcePath = path.resolve(source.pathname);
if (output === sourcePath) throw new Error('refusing to overwrite the tracked production template');

let text = fs.readFileSync(source, 'utf8');
const required = [
  'name = "vishar-telegram-drain-production"',
  'main = "workers/telegram-drain-worker.js"',
  'workers_dev = false',
  'preview_urls = false',
  'VISHAR_ENVIRONMENT = "production"',
  'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"',
  'TELEGRAM_DRAIN_ENABLED = "false"',
  'GMAIL_SHARED_DRAIN_ENABLED = "false"',
];
for (const needle of required) {
  if (!text.includes(needle)) throw new Error(`production template is missing ${needle}`);
}

const forbidden = [
  'gwaliusblwrzisrwnsvs',
  'vishar-telegram-drain-staging',
  'vladimir-staging',
  'kristina-staging',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GMAIL_TOKEN_ENCRYPTION_KEY',
  'GMAIL_OAUTH_STATE',
  'GMAIL_OAUTH_TOKENS',
];
const directives = text
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');
for (const needle of forbidden) {
  if (directives.includes(needle)) throw new Error(`production template contains forbidden staging/provider credential binding: ${needle}`);
}
if (/^\s*\[triggers\]\s*$/m.test(text) || /^\s*crons\s*=/m.test(text)) {
  throw new Error('tracked production template must remain unscheduled');
}
if (/^\s*\[\[services\]\]\s*$/m.test(text)) {
  throw new Error('tracked production template must remain unbound');
}

text = text.replace('TELEGRAM_DRAIN_ENABLED = "false"', 'TELEGRAM_DRAIN_ENABLED = "true"');
text = text.replace('GMAIL_SHARED_DRAIN_ENABLED = "false"', 'GMAIL_SHARED_DRAIN_ENABLED = "true"');
if (!text.includes('TELEGRAM_DRAIN_ENABLED = "true"') || !text.includes('GMAIL_SHARED_DRAIN_ENABLED = "true"')) {
  throw new Error('failed to enable the production shared scheduler in generated config');
}

text += `\n[[services]]\nbinding = "GMAIL_SERVICE"\nservice = "vishar-gmail-production"\n`;
text += `\n[triggers]\ncrons = ["*/5 * * * *"]\n\n[secrets]\nrequired = [\n  "SUPABASE_SECRET_KEY",\n  "ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION",\n  "ARTIST_TELEGRAM_KRISTINA_HPRODUCTION",\n]\n`;
fs.writeFileSync(output, text, { mode: 0o600 });
