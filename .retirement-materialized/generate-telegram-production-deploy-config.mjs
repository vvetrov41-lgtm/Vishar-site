import fs from 'node:fs';
import path from 'node:path';

const source = new URL('../wrangler.telegram-drain.production.toml', import.meta.url);
const args = process.argv.slice(2);
const enableLinking = args.includes('--enable-linking');
const outputArg = args.find((arg) => !arg.startsWith('--'));
if (!outputArg) throw new Error('output path is required');
for (const arg of args) {
  if (arg.startsWith('--') && arg !== '--enable-linking') {
    throw new Error(`unknown option: ${arg}`);
  }
}

const output = path.resolve(outputArg);
const sourcePath = path.resolve(source.pathname);
if (output === sourcePath) throw new Error('refusing to overwrite the tracked production template');

const workerEntrypoint = path.join(path.dirname(sourcePath), 'workers/telegram-drain-worker.js');
if (!fs.existsSync(workerEntrypoint)) {
  throw new Error('production Telegram Worker entrypoint is missing');
}
const relativeWorkerEntrypoint = path.relative(path.dirname(output), workerEntrypoint)
  .split(path.sep)
  .join('/');
if (!relativeWorkerEntrypoint || path.isAbsolute(relativeWorkerEntrypoint)) {
  throw new Error('failed to derive a relative production Telegram Worker entrypoint');
}

let text = fs.readFileSync(source, 'utf8');
const required = [
  'name = "vishar-telegram-drain-production"',
  'main = "workers/telegram-drain-worker.js"',
  'workers_dev = false',
  'preview_urls = false',
  '{ pattern = "telegram.vishartattoo.com", zone_name = "vishartattoo.com", custom_domain = true, enabled = true, previews_enabled = false }',
  'VISHAR_ENVIRONMENT = "production"',
  'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"',
  'TELEGRAM_DRAIN_ENABLED = "false"',
  'GMAIL_SHARED_DRAIN_ENABLED = "false"',
  'AUTOMATION_TICK_ENABLED = "false"',
  'TELEGRAM_LINKING_ENABLED = "false"',
];
for (const needle of required) {
  if (!text.includes(needle)) throw new Error(`production template is missing ${needle}`);
}

const directives = text
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');
const forbidden = [
  'gwaliusblwrzisrwnsvs',
  'vishar-telegram-drain-staging',
  'vladimir-staging',
  'kristina-staging',
  'TELEGRAM_CHAT_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GMAIL_TOKEN_ENCRYPTION_KEY',
  'GMAIL_OAUTH_STATE',
  'GMAIL_OAUTH_TOKENS',
];
for (const needle of forbidden) {
  if (directives.includes(needle)) {
    throw new Error(`production template contains forbidden staging/provider credential binding: ${needle}`);
  }
}
if (/^\s*\[triggers\]\s*$/m.test(text) || /^\s*crons\s*=/m.test(text)) {
  throw new Error('tracked production template must remain unscheduled');
}
if (/^\s*\[\[services\]\]\s*$/m.test(text)) {
  throw new Error('tracked production template must remain unbound');
}

text = text.replace(
  'main = "workers/telegram-drain-worker.js"',
  `main = "${relativeWorkerEntrypoint}"`,
);
text = text.replace('TELEGRAM_DRAIN_ENABLED = "false"', 'TELEGRAM_DRAIN_ENABLED = "true"');
text = text.replace('GMAIL_SHARED_DRAIN_ENABLED = "false"', 'GMAIL_SHARED_DRAIN_ENABLED = "true"');
text = text.replace('AUTOMATION_TICK_ENABLED = "false"', 'AUTOMATION_TICK_ENABLED = "true"');
if (enableLinking) {
  text = text.replace('TELEGRAM_LINKING_ENABLED = "false"', 'TELEGRAM_LINKING_ENABLED = "true"');
}

if (!text.includes(`main = "${relativeWorkerEntrypoint}"`)) {
  throw new Error('failed to resolve the production Telegram Worker entrypoint for generated config');
}
if (!text.includes('TELEGRAM_DRAIN_ENABLED = "true"')) {
  throw new Error('failed to enable the production Telegram drain');
}
if (!text.includes('GMAIL_SHARED_DRAIN_ENABLED = "true"')) {
  throw new Error('failed to preserve the Gmail shared scheduler dispatch');
}
if (!text.includes('AUTOMATION_TICK_ENABLED = "true"')) {
  throw new Error('failed to enable the production automation heartbeat');
}
const expectedLinking = enableLinking ? 'true' : 'false';
if (!text.includes(`TELEGRAM_LINKING_ENABLED = "${expectedLinking}"`)) {
  throw new Error(`failed to generate Telegram linking=${expectedLinking}`);
}

text += `\n[[services]]\nbinding = "GMAIL_SERVICE"\nservice = "vishar-gmail-production"\n`;
text += `\n[triggers]\ncrons = ["*/5 * * * *"]\n\n[secrets]\nrequired = [\n  "SUPABASE_SECRET_KEY",\n  "TELEGRAM_BOT_TOKEN",\n  "TELEGRAM_WEBHOOK_SECRET",\n]\n`;
fs.writeFileSync(output, text, { mode: 0o600 });
