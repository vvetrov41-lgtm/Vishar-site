import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/tattooai-production-release.yml', import.meta.url), 'utf8');
const privateProductionWorkflow = fs.readFileSync(new URL('../.github/workflows/private-production-release.yml', import.meta.url), 'utf8');
const tattooConfig = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').replace(/^\s*#.*$/gm, '');

const expectIncludes = (needle, label) => {
  if (!workflow.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const expectExcludes = (needle, label) => {
  if (workflow.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};

expectIncludes("- 'release/private-crm-rc*-tattooai-worker'", 'release branch boundary');
expectIncludes('case "$GITHUB_REF_NAME" in release/private-crm-rc*-tattooai-worker)', 'runtime release branch gate');
expectIncludes("for workflow in 'Static Validation' 'CRM and booking validation'", 'exact-head CI boundary');
expectIncludes('refs/heads/agent/platform-telegram-self-service', 'canonical branch boundary');
expectIncludes('environment: crm-production', 'production credential environment');
expectIncludes('secrets.CRM_PRODUCTION_CLOUDFLARE_API_TOKEN', 'Worker credential');
expectIncludes('secrets.CRM_PRODUCTION_CLOUDFLARE_ACCOUNT_ID', 'Worker account');
expectExcludes('secrets.CLOUDFLARE_API_TOKEN', 'legacy low-privilege credential');
expectExcludes('secrets.CLOUDFLARE_ACCOUNT_ID', 'legacy low-privilege account');
expectIncludes("grep -Fxq 'name = \"tattooai\"' wrangler.toml", 'exact Worker target gate');
expectIncludes('main = "workers/tattooai-entry.js"', 'exact Worker entrypoint');
expectIncludes("! grep -Eq '^\\s*\\[triggers\\]\\s*$|^\\s*crons\\s*=' wrangler.toml", 'no standalone cron release gate');
expectIncludes('command: deploy --config wrangler.toml --env="" --strict --keep-vars --tag ${{ github.sha }}', 'defensive tagged deploy');
expectIncludes('-X PUT "$api"', 'direct Cloudflare schedule reconciliation');
expectIncludes("--data '[]'", 'zero-schedule payload');
expectIncludes('$api/schedules', 'schedule readback');
expectIncludes('length == 0', 'zero-schedule readback gate');
expectIncludes('.name == "AI" and .type == "ai"', 'Workers AI binding readback');
expectIncludes('.name == "CRM_AI_IMAGES_ENABLED" and .text == "false"', 'images remain disabled');
expectIncludes("endpoint='https://tattooai.vvetrov41.workers.dev/'", 'live Worker boundary');

if (/^\s*\[triggers\]\s*$/m.test(tattooConfig) || /^\s*crons\s*=/m.test(tattooConfig)) {
  throw new Error('tracked TattooAI production config must own zero Cron Triggers');
}

if (!privateProductionWorkflow.includes("- '!release/private-crm-rc*-tattooai-worker'")) {
  throw new Error('private production release must exclude the bounded TattooAI release namespace');
}
const privateTattooAiGuards = privateProductionWorkflow.match(/TattooAI release refs are handled by the bounded TattooAI Worker rollout only\./g) || [];
if (privateTattooAiGuards.length !== 4) {
  throw new Error(`private production release must fail closed for TattooAI refs in all four gates; found ${privateTattooAiGuards.length}`);
}

console.log('TattooAI production release boundaries: exact canonical deploy, zero standalone schedules, Workers AI intact, images disabled.');
