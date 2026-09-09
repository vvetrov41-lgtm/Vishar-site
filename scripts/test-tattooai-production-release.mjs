import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/tattooai-production-release.yml', import.meta.url), 'utf8');
const privateProductionWorkflow = fs.readFileSync(new URL('../.github/workflows/private-production-release.yml', import.meta.url), 'utf8');

const expectIncludes = (needle, label) => {
  if (!workflow.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const expectExcludes = (needle, label) => {
  if (workflow.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};

expectIncludes("- 'release/private-crm-rc*-tattooai-worker'", 'release branch boundary');
expectIncludes('TattooAI production release must use the reserved CRM production release namespace.', 'runtime release branch gate');
expectIncludes("for workflow in 'Static Validation' 'CRM and booking validation'", 'exact-head CI boundary');
expectIncludes('refs/heads/agent/platform-telegram-self-service', 'canonical branch boundary');
expectIncludes('name: crm-production', 'production credential environment');
expectIncludes('secrets.CRM_PRODUCTION_CLOUDFLARE_API_TOKEN', 'scheduled Worker credential');
expectIncludes('secrets.CRM_PRODUCTION_CLOUDFLARE_ACCOUNT_ID', 'scheduled Worker account');
expectExcludes('secrets.CLOUDFLARE_API_TOKEN', 'legacy low-privilege credential');
expectExcludes('secrets.CLOUDFLARE_ACCOUNT_ID', 'legacy low-privilege account');
expectIncludes('test "$(sed -n', 'exact Worker target gate');
expectIncludes('= "tattooai"', 'exact Worker target');
expectIncludes('main = "workers/tattooai-entry.js"', 'exact Worker entrypoint');
expectIncludes("assert crons == ['*/5 * * * *']", 'canonical cron contract');
expectIncludes("assert 'triggers' not in deploy_config", 'code-only config strips trigger mutation');
expectIncludes('command: deploy --config .tattooai.deploy.toml --env="" --strict --keep-vars --tag ${{ github.sha }}', 'defensive tagged code-only deploy');
expectIncludes('-X PUT "$api"', 'direct Cloudflare cron reconciliation');
expectIncludes('--data-binary @/tmp/tattooai-schedules-request.json', 'canonical cron payload');
expectIncludes("crons == ['*/5 * * * *']", 'cron write response gate');
expectIncludes('$api/schedules', 'cron readback');
expectIncludes("config.get('triggers', {}).get('crons', [])", 'cron snapshot comparison');
expectIncludes('bindings.get(\'AI\', {}).get(\'type\') == \'ai\'', 'Workers AI binding readback');
expectIncludes('https://vfjexhfdbrjmuxfdvbdx.supabase.co', 'production Supabase binding');
expectIncludes("endpoint='https://tattooai.vvetrov41.workers.dev/'", 'live Worker boundary');
expectIncludes("-X POST 'https://www.kristinavishar.com/api/booking'", 'live booking adapter boundary');

if (!privateProductionWorkflow.includes("- '!release/private-crm-rc*-tattooai-worker'")) {
  throw new Error('private production release must exclude the bounded TattooAI release namespace');
}
const privateTattooAiGuards = privateProductionWorkflow.match(/TattooAI release refs are handled by the bounded TattooAI Worker rollout only\./g) || [];
if (privateTattooAiGuards.length !== 4) {
  throw new Error(`private production release must fail closed for TattooAI refs in all four gates; found ${privateTattooAiGuards.length}`);
}

console.log('TattooAI production release boundaries: passed');
