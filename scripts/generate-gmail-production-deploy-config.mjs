import fs from 'node:fs';

const [output, phase] = process.argv.slice(2);
if (!output) throw new Error('output path is required');
const phases = new Set(['bootstrap', 'vladimir-read', 'vladimir-send', 'kristina-read', 'kristina-send']);
if (!phases.has(phase)) throw new Error('invalid Gmail production phase');

const stateId = String(process.env.GMAIL_KV_STATE_ID || '').trim();
const tokensId = String(process.env.GMAIL_KV_TOKENS_ID || '').trim();
const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
if (!/^[0-9a-f]{32}$/.test(stateId) || !/^[0-9a-f]{32}$/.test(tokensId) || stateId === tokensId) {
  throw new Error('dedicated Gmail production KV namespace ids are required');
}
if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publishableKey)) {
  throw new Error('production Supabase publishable key is required');
}

const enabled = phase !== 'bootstrap';
const drain = phase === 'vladimir-send' || phase === 'kristina-read' || phase === 'kristina-send';
const kristina = phase === 'kristina-read' || phase === 'kristina-send';

let config = fs.readFileSync('wrangler.gmail.production.toml', 'utf8');
const replacements = new Map([
  ['GMAIL_OAUTH_ENABLED = "false"', `GMAIL_OAUTH_ENABLED = "${enabled}"`],
  ['GMAIL_READ_ENABLED = "false"', `GMAIL_READ_ENABLED = "${enabled}"`],
  ['GMAIL_DRAIN_ENABLED = "false"', `GMAIL_DRAIN_ENABLED = "${drain}"`],
  ['GMAIL_VLADIMIR_ENABLED = "false"', `GMAIL_VLADIMIR_ENABLED = "${enabled}"`],
  ['GMAIL_KRISTINA_ENABLED = "false"', `GMAIL_KRISTINA_ENABLED = "${kristina}"`],
]);
for (const [from, to] of replacements) {
  if (!config.includes(from)) throw new Error(`tracked Gmail config is missing ${from}`);
  config = config.replace(from, to);
}
if (!config.includes('SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"')) {
  throw new Error('tracked Gmail config is not production-bound');
}
config = config.replace(
  'SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"',
  `SUPABASE_URL = "https://vfjexhfdbrjmuxfdvbdx.supabase.co"\nSUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(publishableKey)}`,
);
config += `\n[[kv_namespaces]]\nbinding = "GMAIL_OAUTH_STATE"\nid = "${stateId}"\n`;
config += `\n[[kv_namespaces]]\nbinding = "GMAIL_OAUTH_TOKENS"\nid = "${tokensId}"\n`;
if (drain) config += '\n[triggers]\ncrons = ["*/5 * * * *"]\n';

fs.writeFileSync(output, config);
