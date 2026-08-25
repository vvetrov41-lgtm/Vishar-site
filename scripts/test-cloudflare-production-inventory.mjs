import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/cloudflare-production-inventory.yml', import.meta.url), 'utf8');
const script = await readFile(new URL('./cloudflare-production-inventory.mjs', import.meta.url), 'utf8');

assert.match(workflow, /name: Cloudflare production inventory/);
assert.match(workflow, /environment: crm-production/);
assert.match(workflow, /github\.actor == github\.repository_owner/);
assert.match(workflow, /agent\/platform-telegram-self-service/);
assert.match(workflow, /CRM_PRODUCTION_CLOUDFLARE_API_TOKEN/);
assert.match(workflow, /CRM_PRODUCTION_CLOUDFLARE_ACCOUNT_ID/);
assert.match(workflow, /actions\/upload-artifact@v4/);
assert.doesNotMatch(workflow, /wrangler\s+(deploy|delete|secret|kv|r2|d1|queues)/i);
assert.doesNotMatch(workflow, /curl[^\n]*(--request|-X)\s*(POST|PUT|PATCH|DELETE)/i);
assert.doesNotMatch(workflow, /supabase\s+(db push|migration|functions deploy)/i);

assert.match(script, /fetch\(`\$\{API_ROOT\}\$\{path\}`, \{ method: 'GET'/);
assert.doesNotMatch(script, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i);
assert.match(script, /case 'secret_text':[\s\S]*case 'json':[\s\S]*break;/);
assert.match(script, /secret_names/);
assert.match(script, /\[redacted\]/);
assert.match(script, /Cloudflare mutations: none \(GET requests only\)/);
assert.match(script, /Secret values: never requested; secret names only/);

console.log('Cloudflare production inventory workflow safety tests passed.');
