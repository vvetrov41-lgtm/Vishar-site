import fs from 'node:fs';
import path from 'node:path';

const source = new URL('../wrangler.whatsapp-drain.production.toml', import.meta.url);
const outputArg = process.argv[2];
if (!outputArg) throw new Error('output path is required');

const output = path.resolve(outputArg);
const sourcePath = path.resolve(source.pathname);
if (output === sourcePath) throw new Error('refusing to overwrite the tracked production template');

let text = fs.readFileSync(source, 'utf8');
const required = [
  'name = "vishar-whatsapp-drain-production"',
  'main = "workers/whatsapp-drain-worker.js"',
  'workers_dev = false',
  'preview_urls = false',
  'VISHAR_ENVIRONMENT = "production"',
  'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"',
  'WHATSAPP_DRAIN_ENABLED = "false"',
];
for (const needle of required) {
  if (!text.includes(needle)) throw new Error(`production template is missing ${needle}`);
}

// Comments may legitimately name a forbidden token while explaining why it is
// absent, so the check runs against directives only.
const forbidden = [
  'gwaliusblwrzisrwnsvs',
  'vishar-whatsapp-drain-staging',
  'vladimir-staging',
  'kristina-staging',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
];
const directives = text
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');
for (const needle of forbidden) {
  if (directives.includes(needle)) throw new Error(`production template contains forbidden staging/global token: ${needle}`);
}
if (/^\s*\[triggers\]\s*$/m.test(text) || /^\s*crons\s*=/m.test(text)) {
  throw new Error('tracked production template must remain unscheduled');
}

text = text.replace('WHATSAPP_DRAIN_ENABLED = "false"', 'WHATSAPP_DRAIN_ENABLED = "true"');
if (!text.includes('WHATSAPP_DRAIN_ENABLED = "true"')) {
  throw new Error('failed to enable the production drain in generated config');
}

text += `\n[triggers]\ncrons = ["*/5 * * * *"]\n\n[secrets]\nrequired = [\n  "SUPABASE_SECRET_KEY",\n  "ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION",\n  "ARTIST_WHATSAPP_KRISTINA_HPRODUCTION",\n]\n`;
fs.writeFileSync(output, text, { mode: 0o600 });
