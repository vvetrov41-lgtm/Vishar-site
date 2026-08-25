import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/cloudflare-production-inventory.yml', import.meta.url), 'utf8');
const script = await readFile(new URL('./cloudflare-production-inventory.mjs', import.meta.url), 'utf8');

assert.match(workflow, /name: Cloudflare production inventory/);
assert.match(workflow, /environment: crm-production/);
assert.match(workflow, /github\.actor == github\.repository_owner/);
assert.match(workflow, /agent\/platform-telegram-self-service/);
assert.match(workflow, /release\/private-crm-rc\*-inventory-\*/);
assert.match(workflow, /github\.event\.before/);
assert.match(workflow, /GITHUB_SHA\^/);
assert.match(workflow, /GITHUB_SHA\^\{tree\}/);
assert.match(workflow, /group: cloudflare-production-inventory-\$\{\{ inputs\.approved_sha \|\| github\.event\.before \|\| github\.sha \}\}/);
assert.match(workflow, /github\.event_name != 'push' \|\| github\.event\.before != '0000000000000000000000000000000000000000'/);
assert.doesNotMatch(workflow, /group: cloudflare-production-inventory\s*$/m);
assert.match(workflow, /CRM_PRODUCTION_CLOUDFLARE_API_TOKEN/);
assert.match(workflow, /CRM_PRODUCTION_CLOUDFLARE_ACCOUNT_ID/);
assert.match(workflow, /actions\/upload-artifact@v4/);
assert.match(workflow, /statuses: write/);
assert.match(workflow, /context='cloudflare-production-inventory'/);
assert.match(workflow, /actions\/runs\/\$GITHUB_RUN_ID/);
assert.doesNotMatch(workflow, /branches:\s*\n\s*- 'agent\/platform-telegram-self-service'/);
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
assert.match(script, /zones\/\$\{zone\.id\}\/access\/apps/);
assert.match(script, /Access applications are unreadable at both account and zone scope/);
assert.match(script, /HTTP_BOUNDARIES/);
assert.match(script, /redirect: 'manual'/);
assert.match(script, /safeRedirectTarget/);
assert.match(script, /target\.origin/);
assert.doesNotMatch(script, /response\.headers\.get\(['"]set-cookie['"]\)/i);
assert.match(script, /pages\/projects`\)/);
assert.match(script, /deployments`\)/);
assert.match(script, /errorCodes\.join/);
assert.match(script, /function listRows/);
for (const key of ['scripts', 'projects', 'deployments', 'apps', 'policies', 'namespaces', 'queues', 'buckets']) {
  assert.match(script, new RegExp(`['"]${key}['"]`));
}
assert.match(script, /list response shape is unsupported/);
assert.doesNotMatch(script, /pages\/projects\?/);
assert.doesNotMatch(script, /deployments\?page=/);

console.log('Cloudflare production inventory workflow safety tests passed, including branch-creation skip and approved-SHA keyed concurrency.');
