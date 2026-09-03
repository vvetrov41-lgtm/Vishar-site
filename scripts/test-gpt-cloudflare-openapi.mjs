import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../docs/gpt-actions/openapi.production.cloudflare.yaml', import.meta.url), 'utf8');
const ids = [...schema.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);

const reads = [
  'getCloudflareAccount',
  'listCloudflareZones',
  'listCloudflareWorkers',
  'getCloudflareWorker',
  'listCloudflareWorkerDeployments',
  'listCloudflarePagesProjects',
  'listCloudflareD1Databases',
  'listCloudflareKvNamespaces',
  'listCloudflareR2Buckets',
  'listCloudflareDnsRecords',
  'listCloudflareWorkerRoutes',
];
const writes = [
  'deployCloudflareWorkerCode',
  'deleteCloudflareWorker',
  'upsertCloudflareDnsRecord',
  'deleteCloudflareDnsRecord',
  'purgeCloudflareCache',
  'upsertCloudflareWorkerRoute',
  'deleteCloudflareWorkerRoute',
];

assert.equal(ids.length, 18, 'Cloudflare schema must expose exactly the reviewed 18 operations');
assert.equal(new Set(ids).size, 18, 'Cloudflare operation IDs must be unique');
assert.ok(ids.length <= 25, 'Cloudflare schema must stay below the preferred ChatGPT operation limit');
for (const id of [...reads, ...writes]) assert.ok(ids.includes(id), `${id} must remain in the reviewed Cloudflare schema`);

assert.match(schema, /^openapi: 3\.1\.0$/m);
assert.match(schema, /url: https:\/\/gpt-cloudflare\.vishartattoo\.com/);
assert.match(schema, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
assert.match(schema, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);

for (const id of reads) {
  assert.match(schema, new RegExp(`operationId: ${id}[\\s\\S]{0,500}?x-openai-isConsequential: false`), `${id} must be non-consequential`);
}
for (const id of writes) {
  assert.match(schema, new RegExp(`operationId: ${id}[\\s\\S]{0,700}?x-openai-isConsequential: true`), `${id} must be consequential`);
}

assert.doesNotMatch(
  schema,
  /\b(account_id|zone_id|api_token|access_token|oauth_client_id|integration_key|secret_value|service_role|SUPABASE_SECRET_KEY|sb_secret_|sql|rpc|upstream|url_path)\b/i,
  'ChatGPT Cloudflare schema must not expose provider credentials, internal IDs or arbitrary proxy selectors',
);
assert.doesNotMatch(schema, /name:\s*(?:method|headers|authorization|provider)\b/i,
  'ChatGPT Cloudflare schema must not expose generic HTTP/provider selectors');
assert.match(schema, /additionalProperties: false/g,
  'every Cloudflare write/read-body schema must use bounded object shapes');

console.log('GPT Cloudflare OpenAPI tests passed: 11 reads + 7 consequential writes');
