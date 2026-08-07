import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function count(text, value) {
  return text.split(value).length - 1;
}

function versionAtLeast(actual, minimum) {
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

const tools = read('workers/lib/ai-tools.js');
const proxy = read('workers/lib/gpt-actions.js');
const entrypoint = read('workers/gpt-actions.js');
const migration = read('supabase/migrations/0032_gpt_appointment_actions.sql');
const hardening = read('supabase/migrations/0033_gpt_appointment_actions_hardening.sql');
const consentGuard = read('supabase/migrations/0034_gpt_oauth_consent_guard.sql');
const openapi = read('docs/gpt-actions/openapi.staging.yaml');
const runbook = read('docs/crm/gpt-appointment-actions.md');
const consentApi = read('admin/src/lib/oauth-consent-api.ts');
const consentPage = read('admin/src/pages/OAuthConsentPage.tsx');
const app = read('admin/src/App.tsx');
const packageJson = JSON.parse(read('package.json'));
const adminLock = JSON.parse(read('admin/package-lock.json'));

assert.match(
  tools,
  /export const AI_GATEWAY_CONNECTED = false;/,
  'GPT gateway must remain explicitly disconnected in source',
);
for (const tool of [
  'search_appointment_clients',
  'list_appointments',
  'get_appointment',
  'check_appointment_conflicts',
  'schedule_appointment',
  'reschedule_appointment',
  'cancel_appointment',
]) {
  assert.match(tools, new RegExp(`name: '${tool}'`), `missing closed GPT tool ${tool}`);
}
assert.equal(
  count(tools, 'oauthClientBound: true'),
  7,
  'every and only the seven GPT appointment tools must be OAuth-client-bound',
);
assert.equal(
  count(tools, 'consequential: true'),
  3,
  'only schedule, reschedule and cancel are consequential GPT writes',
);

assert.match(proxy, /GPT_ACTIONS_ENABLED === 'true'/, 'proxy must fail closed behind an explicit flag');
assert.doesNotMatch(proxy, /SUPABASE_SECRET_KEY/, 'proxy must never accept a Supabase secret key');
assert.doesNotMatch(proxy, /service_role/, 'proxy must never use the Supabase service role');
assert.doesNotMatch(proxy, /p_artist_id/, 'proxy must never forward artist_id to an RPC');
assert.match(proxy, /forbidden_field:\$\{forbidden\}/, 'proxy must reject authoritative identity fields');
assert.match(proxy, /MAX_BODY_BYTES = 16 \* 1024/, 'request body must remain bounded');
assert.match(proxy, /MAX_RESPONSE_BYTES = 128 \* 1024/, 'response body must remain bounded');
assert.match(proxy, /boundedQueryInteger\(url\.searchParams\.get\('limit'\), 'limit', 20, 25\)/,
  'appointment listing must remain capped to 25 at the edge');
assert.match(entrypoint, /omitNullFields/, 'public entrypoint must remove optional null fields');

for (const key of ['vladimir-gpt-actions', 'kristina-gpt-actions']) {
  assert.match(migration, new RegExp(`'${key}'`), `missing logical GPT integration ${key}`);
}
assert.equal(
  count(migration, 'true, true, false'),
  2,
  'both logical GPT clients must remain disabled by default',
);
assert.doesNotMatch(
  migration,
  /oauth_client_id\s*=\s*'[^']+'/,
  'no real OAuth client id may be committed in a migration',
);
assert.match(
  migration,
  /auth\.jwt\(\) ->> 'client_id'/,
  'database artist scope must derive from the OAuth client_id claim',
);
assert.match(
  hardening,
  /gpt_client_in_artist_scope/,
  'writes must verify that the selected client already belongs to the fixed artist scope',
);
assert.match(hardening, /digest\([\s\S]*'sha256'/, 'idempotency receipts must use SHA-256');
assert.doesNotMatch(hardening, /md5\(/, 'GPT idempotency must not use MD5');

assert.match(
  consentGuard,
  /create or replace function public\.get_gpt_action_consent_summary/,
  'consent page must use a database-owned OAuth client guard',
);
assert.match(
  consentGuard,
  /require_artist_access\(v_client\.artist_id, 'manage_sessions'\)/,
  'write-capable consent must require human appointment-management access',
);
assert.match(
  consentGuard,
  /grant execute on function public\.get_gpt_action_consent_summary\(text\)[\s\S]*to authenticated/,
  'only authenticated CRM users may call the consent summary',
);
assert.match(
  consentApi,
  /get_gpt_action_consent_summary/,
  'browser consent must verify the OAuth client against the database guard',
);
assert.match(
  consentApi,
  /scopes\.length !== 1 \|\| scopes\[0\] !== 'email'/,
  'consent must reject every scope except the single approved email scope',
);
assert.match(
  consentApi,
  /parsed\.protocol !== 'https:'/,
  'consent redirects must fail closed unless HTTPS',
);
assert.match(app, /case '\/oauth\/consent':/, 'active CRM routing must include the OAuth consent path');
assert.match(consentPage, /can_manage_appointments/, 'consent UI must display read versus write access');
assert.match(consentPage, /cannot switch artist|не может переключить артиста/,
  'consent UI must state the fixed artist boundary');

const supabaseVersion = adminLock.packages?.['node_modules/@supabase/supabase-js']?.version;
assert.equal(typeof supabaseVersion, 'string', 'admin lockfile must pin supabase-js');
assert.ok(
  versionAtLeast(supabaseVersion, '2.94.1'),
  `supabase-js ${supabaseVersion} is too old for the corrected OAuth consent API`,
);

assert.match(openapi, /^openapi: 3\.1\.0$/m, 'OpenAPI version must remain explicit');
assert.match(
  openapi,
  /url: https:\/\/gpt-actions-staging\.vishartattoo\.com/,
  'OpenAPI server must remain the retained-staging hostname',
);
assert.doesNotMatch(openapi, /gpt-actions\.vishartattoo\.com/, 'production GPT hostname is forbidden');
assert.doesNotMatch(openapi, /artist_id/, 'GPT schema must never allow caller-selected artist_id');
assert.doesNotMatch(openapi, /service_role|SUPABASE_SECRET_KEY/, 'GPT schema must contain no privileged key surface');
assert.match(
  openapi,
  /authorizationUrl: https:\/\/gwaliusblwrzisrwnsvs\.supabase\.co\/auth\/v1\/oauth\/authorize/,
  'OpenAPI must use the retained-staging Supabase OAuth authorization endpoint',
);
assert.match(
  openapi,
  /tokenUrl: https:\/\/gwaliusblwrzisrwnsvs\.supabase\.co\/auth\/v1\/oauth\/token/,
  'OpenAPI must use the retained-staging Supabase OAuth token endpoint',
);
assert.equal(
  count(openapi, 'x-openai-isConsequential: true'),
  3,
  'all three appointment mutations must remain consequential',
);
assert.equal(
  count(openapi, 'x-openai-isConsequential: false'),
  4,
  'the four read-only operations must remain non-consequential',
);
const operationIds = [...openapi.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
assert.deepEqual(
  operationIds.sort(),
  [
    'cancelAppointment',
    'checkAppointmentConflicts',
    'getAppointment',
    'listAppointments',
    'rescheduleAppointment',
    'scheduleAppointment',
    'searchAppointmentClients',
  ].sort(),
  'OpenAPI must expose exactly the seven approved operations',
);

assert.match(runbook, /AI_GATEWAY_CONNECTED` remains `false`/,
  'runbook must record the disconnected deployment state');
assert.match(runbook, /Do not put Cloudflare Access in front of the action endpoint/,
  'runbook must preserve OAuth bearer authentication for ChatGPT server requests');
assert.match(runbook, /Do not reuse Vladimir's OAuth client/,
  'runbook must require a separate Kristina OAuth client');

assert.match(
  packageJson.scripts['test:worker'],
  /test-gpt-actions\.mjs/,
  'normal Worker tests must include GPT proxy tests',
);
assert.match(
  packageJson.scripts['test:worker'],
  /test-gpt-actions-entrypoint\.mjs/,
  'normal Worker tests must include public response sanitisation',
);
assert.match(
  packageJson.scripts['test:worker'],
  /validate-gpt-actions\.mjs/,
  'normal Worker tests must include GPT static validation',
);

console.log('GPT Actions validation passed: disabled, OAuth-bound, artist-scoped and staging-only.');
